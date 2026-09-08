/**
 * Settlement operations API.
 *
 * Everything here is behind OPS_API_KEY. None of it is for banks or customers:
 * it is the view an operator needs to answer "is the system telling the truth",
 * and the levers to act when it is not.
 *
 * The exception is `/settlement/proof/:entityType/:entityId`, which is
 * deliberately readable by the counterparty to a settlement — an on-chain proof
 * that only we can see is not a proof of anything.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../core/ledger.service';
import { trialBalance, statement } from '../core/settlement/journal.service';
import { accountBalance } from '../core/settlement/accounts';
import { legsFor, stuckLegs } from '../core/settlement/leg.service';
import { proofsFor } from '../core/settlement/proof.service';
import { workerStatus, tick } from '../core/settlement/resume.worker';
import { runReconciliation, latestRun, resolveBreak } from '../core/settlement/reconciliation.service';
import { outboxStatus, replay } from '../core/outbox.service';
import { breakerSnapshot, resetBreaker } from '../core/provider/circuit-breaker';
import { providerHealth, attemptsFor } from '../core/provider/attempt.service';
import { advanceDeposit, advanceWithdrawal, confirmPartnerPayout } from '../core/settlement/usd-corridor.service';
import { health as solanaHealth } from '../providers/live/solana';

const router = Router();

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireOpsKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.OPS_API_KEY ?? '';
  if (!expected) {
    res.status(503).json({ error: 'OPS_API_KEY is not configured — ops endpoints are disabled' });
    return;
  }
  const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  // Length-first comparison, then constant-time over equal-length strings.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

// ── Public: settlement proof ──────────────────────────────────────────────────
//
// Returns the Solana signature and slot for a settlement, with an explorer
// link. A counterparty can verify it against any node without trusting us,
// which is the entire argument for this network over SWIFT.

router.get(
  '/proof/:entityType/:entityId',
  wrap(async (req, res) => {
    const { entityType, entityId } = req.params;
    const proofs = await proofsFor(entityType, entityId);
    res.json({
      entityType,
      entityId,
      proven: proofs.some(p => p.commitment === 'finalized' && !p.onchainError),
      proofs,
    });
  }),
);

router.use(requireOpsKey);

// ── Books ─────────────────────────────────────────────────────────────────────

router.get(
  '/books/trial-balance',
  wrap(async (req, res) => {
    const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : undefined;
    const rows = await trialBalance(asOf);
    res.json({
      asOf: asOf ?? new Date(),
      balanced: rows.every(r => r.balanced),
      rows: rows.map(r => ({
        currency: r.currency,
        debits: r.debits.toString(),
        credits: r.credits.toString(),
        residual: r.residual.toString(),
        balanced: r.balanced,
      })),
    });
  }),
);

router.get(
  '/books/account/:code',
  wrap(async (req, res) => {
    const code = decodeURIComponent(req.params.code);
    res.json(await statement(code, { limit: Number(req.query.limit ?? 200) }));
  }),
);

router.get(
  '/books/balance/:code',
  wrap(async (req, res) => {
    const code = decodeURIComponent(req.params.code);
    res.json({ account: code, balance: (await accountBalance(code)).toString() });
  }),
);

router.get(
  '/books/accounts',
  wrap(async (_req, res) => {
    const accounts = await prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' }, take: 500 });
    res.json({ count: accounts.length, accounts: accounts.map(a => ({ code: a.code, type: a.type, currency: a.currency })) });
  }),
);

// ── Settlements ───────────────────────────────────────────────────────────────

router.get(
  '/legs/:entityType/:entityId',
  wrap(async (req, res) => {
    const legs = await legsFor(req.params.entityType, req.params.entityId);
    res.json({
      entity: `${req.params.entityType}:${req.params.entityId}`,
      settled: legs.length > 0 && legs.every(l => l.status === 'COMPLETED'),
      legs: legs.map(l => ({
        sequence: l.sequence,
        kind: l.kind,
        status: l.status,
        asset: l.asset,
        amount: l.amount?.toString() ?? null,
        externalRef: l.externalRef,
        attempts: l.attempts,
        lastError: l.lastError,
        nextAttemptAt: l.nextAttemptAt,
      })),
    });
  }),
);

/**
 * Settlements that have exhausted their retries. This queue should be empty.
 * Every row is customer money in an indeterminate state.
 */
router.get(
  '/stuck',
  wrap(async (_req, res) => {
    const stuck = await stuckLegs();
    res.json({
      count: stuck.length,
      legs: stuck.map(l => ({
        entity: `${l.entityType}:${l.entityId}`,
        sequence: l.sequence,
        kind: l.kind,
        status: l.status,
        attempts: l.attempts,
        lastError: l.lastError,
        stuckSince: l.updatedAt,
      })),
    });
  }),
);

/** Nudge one settlement forward by hand. Idempotent — legs guard themselves. */
router.post(
  '/advance/:entityType/:entityId',
  wrap(async (req, res) => {
    const { entityType, entityId } = req.params;
    if (entityType === 'BankDeposit') await advanceDeposit(entityId);
    else if (entityType === 'Withdrawal') await advanceWithdrawal(entityId);
    else {
      res.status(400).json({ error: `Cannot advance entity type '${entityType}'` });
      return;
    }
    res.json({ ok: true, legs: await legsFor(entityType, entityId) });
  }),
);

/**
 * Record that a payout partner confirmed the wire landed. This is the only
 * path that closes a withdrawal — until it runs, the money is still ours and
 * sits in suspense.
 */
router.post(
  '/withdrawals/:id/confirm',
  wrap(async (req, res) => {
    const reference = String(req.body?.partnerReference ?? '').trim();
    if (!reference) {
      res.status(400).json({ error: 'partnerReference is required — it is the audit link to the partner statement' });
      return;
    }
    await confirmPartnerPayout(req.params.id, reference);
    res.json({ ok: true });
  }),
);

router.get('/worker', wrap(async (_req, res) => res.json(await workerStatus())));
router.post('/worker/tick', wrap(async (_req, res) => res.json(await tick())));

// ── Reconciliation ────────────────────────────────────────────────────────────

router.post(
  '/reconcile',
  wrap(async (req, res) => {
    const kind = (req.body?.kind ?? 'FULL') as 'TRIAL_BALANCE' | 'CUSTODY' | 'ONCHAIN' | 'FULL';
    res.json(await runReconciliation(kind));
  }),
);

router.get(
  '/reconcile/latest',
  wrap(async (req, res) => {
    const run = await latestRun(req.query.kind ? String(req.query.kind) : undefined);
    if (!run) {
      res.status(404).json({ error: 'No reconciliation has been run yet' });
      return;
    }
    res.json(run);
  }),
);

router.post(
  '/reconcile/breaks/:id/resolve',
  wrap(async (req, res) => {
    const note = String(req.body?.note ?? '').trim();
    if (!note) {
      res.status(400).json({ error: 'note is required — a break resolved without an explanation is not resolved' });
      return;
    }
    res.json(await resolveBreak(req.params.id, note));
  }),
);

// ── Providers ─────────────────────────────────────────────────────────────────

router.get(
  '/providers/health',
  wrap(async (req, res) => {
    res.json({
      circuits: breakerSnapshot(),
      performance: await providerHealth(Number(req.query.hours ?? 24)),
    });
  }),
);

router.post(
  '/providers/:id/reset-circuit',
  wrap(async (req, res) => {
    resetBreaker(req.params.id);
    res.json({ ok: true, providerId: req.params.id });
  }),
);

router.get(
  '/providers/attempts/:entityType/:entityId',
  wrap(async (req, res) => res.json(await attemptsFor(req.params.entityType, req.params.entityId))),
);

// ── Outbox ────────────────────────────────────────────────────────────────────

router.get('/outbox', wrap(async (_req, res) => res.json(await outboxStatus())));

router.post(
  '/outbox/:id/replay',
  wrap(async (req, res) => {
    await replay(req.params.id);
    res.json({ ok: true });
  }),
);

// ── Infrastructure ────────────────────────────────────────────────────────────

router.get(
  '/infra',
  wrap(async (_req, res) => {
    const solana = await solanaHealth();
    res.json({
      solana,
      rpcConfigured: Boolean(process.env.SOLANA_RPC_URL),
      // A public RPC endpoint is rate-limited and unsuitable for settlement
      // verification under load. Flag it rather than let it be discovered
      // during an incident.
      warning: process.env.SOLANA_RPC_URL
        ? undefined
        : 'SOLANA_RPC_URL is unset — falling back to the public mainnet endpoint, which is rate-limited and not suitable for production settlement verification',
    });
  }),
);

export default router;
