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
import { prisma } from '../../../../packages/core/ledger/ledger.service';
import { trialBalance, statement } from '../../../../packages/core/ledger/journal.service';
import { accountBalance } from '../../../../packages/core/ledger/accounts';
import { legsFor, stuckLegs } from '../../../../packages/settlement/orchestration/leg.service';
import { proofsFor } from '../../../../packages/settlement/proof/proof.service';
import { workerStatus, tick } from '../../../../packages/settlement/orchestration/resume.worker';
import { runReconciliation, latestRun, resolveBreak } from '../../../../packages/settlement/reconciliation/reconciliation.service';
import { outboxStatus, replay } from '../../../../packages/core/events/outbox.service';
import { breakerSnapshot, resetBreaker } from '../../../../packages/providers/runtime/circuit-breaker';
import { providerHealth, attemptsFor } from '../../../../packages/providers/runtime/attempt.service';
import { advanceDeposit, advanceWithdrawal, confirmPartnerPayout } from '../../../../packages/settlement/orchestration/usd-corridor.service';
import { health as solanaHealth } from '../../../../packages/providers/blockchain/solana/solana';

// Express 5 types route params as `string | string[]`, because a wildcard
// segment can legitimately repeat. Every route in this file declares
// single-segment params, so narrow once here rather than casting at each
// call site — and take the first value rather than silently joining, so a
// hand-crafted duplicate param cannot smuggle a second id past a lookup.
const param = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

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
    const entityType = param(req.params.entityType);
    const entityId   = param(req.params.entityId);
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

// ── Outbound settlement approvals (Step 2, slice 5) ───────────────────────────
// Four-eyes: an institution asks, an operator approves. In PRODUCTION every transfer waits here;
// in SANDBOX only those above the auto-approve limit. Counterparties in PRODUCTION are approved
// here too, with an attestation that the address is whitelisted at the custodian.
router.get('/transfers/pending', wrap(async (_req, res) => {
  const { listAwaitingApproval, serializeTransfer } = await import('../../../../packages/settlement/transfers/settlement-transfer.service');
  const rows = await listAwaitingApproval();
  res.json(await Promise.all(rows.map(async t => ({ ...(await serializeTransfer(t)), institution: t.institution.slug, environment: t.environment.kind, policy: t.policy }))));
}));
router.post('/transfers/:id/approve', wrap(async (req, res) => {
  const { approveTransfer, serializeTransfer } = await import('../../../../packages/settlement/transfers/settlement-transfer.service');
  const by = typeof req.body?.by === 'string' && req.body.by.trim() ? `operator:${req.body.by.trim().slice(0, 80)}` : 'operator';
  res.json(await serializeTransfer(await approveTransfer(param(req.params.id), by)));
}));
router.post('/transfers/:id/reject', wrap(async (req, res) => {
  const { rejectTransfer, serializeTransfer } = await import('../../../../packages/settlement/transfers/settlement-transfer.service');
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'no reason given';
  const by = typeof req.body?.by === 'string' && req.body.by.trim() ? `operator:${req.body.by.trim().slice(0, 80)}` : 'operator';
  res.json(await serializeTransfer(await rejectTransfer(param(req.params.id), by, reason)));
}));
router.post('/transfers/sweep', wrap(async (_req, res) => {
  const { runTransferSweep, submitApprovedTransfers, pollSubmittedTransfers, finalizeConfirmedTransfers } = await import('../../../../packages/settlement/transfers/settlement-transfer.service');
  void runTransferSweep; const submitted = await submitApprovedTransfers(); const polled = await pollSubmittedTransfers(); const finalized = await finalizeConfirmedTransfers();
  res.json({ submitted, polled, finalized });
}));
router.get('/counterparties/pending', wrap(async (_req, res) => {
  const rows = await prisma.counterparty.findMany({ where: { status: 'PENDING_APPROVAL' }, orderBy: { createdAt: 'asc' }, include: { institution: { select: { slug: true } }, environment: { select: { kind: true } } } });
  res.json(rows.map(c => ({ id: c.id, institution: c.institution.slug, environment: c.environment.kind, label: c.label, network: c.network, address: c.address, note: c.note, createdAt: c.createdAt })));
}));
router.post('/counterparties/:id/approve', wrap(async (req, res) => {
  const { approveCounterparty, serializeCounterparty } = await import('../../../../packages/settlement/transfers/counterparty.service');
  const by = typeof req.body?.by === 'string' && req.body.by.trim() ? `operator:${req.body.by.trim().slice(0, 80)}` : 'operator';
  res.json(serializeCounterparty(await approveCounterparty(param(req.params.id), by, { custodyWhitelisted: req.body?.custodyWhitelisted === true, note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined })));
}));
router.post('/counterparties/:id/reject', wrap(async (req, res) => {
  const { rejectCounterparty, serializeCounterparty } = await import('../../../../packages/settlement/transfers/counterparty.service');
  const by = typeof req.body?.by === 'string' && req.body.by.trim() ? `operator:${req.body.by.trim().slice(0, 80)}` : 'operator';
  res.json(serializeCounterparty(await rejectCounterparty(param(req.params.id), by, typeof req.body?.reason === 'string' ? req.body.reason : 'no reason given')));
}));

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
    const code = decodeURIComponent(param(req.params.code));
    res.json(await statement(code, { limit: Number(req.query.limit ?? 200) }));
  }),
);

router.get(
  '/books/balance/:code',
  wrap(async (req, res) => {
    const code = decodeURIComponent(param(req.params.code));
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
    const legs = await legsFor(param(req.params.entityType), param(req.params.entityId));
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
    const entityType = param(req.params.entityType);
    const entityId   = param(req.params.entityId);
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
    await confirmPartnerPayout(param(req.params.id), reference);
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
    res.json(await resolveBreak(param(req.params.id), note));
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
    resetBreaker(param(req.params.id));
    res.json({ ok: true, providerId: param(req.params.id) });
  }),
);

router.get(
  '/providers/attempts/:entityType/:entityId',
  wrap(async (req, res) => res.json(await attemptsFor(param(req.params.entityType), param(req.params.entityId)))),
);

// ── Outbox ────────────────────────────────────────────────────────────────────

router.get('/outbox', wrap(async (_req, res) => res.json(await outboxStatus())));

router.post(
  '/outbox/:id/replay',
  wrap(async (req, res) => {
    await replay(param(req.params.id));
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


// ── Providers (Step 2, slice 3): who fills each role, configured or stub, live health ──
router.get('/providers', async (req, res, next) => {
  try {
    const { describeProviders } = await import('../../../../packages/providers/registry/provider-registry');
    res.json({ providers: await describeProviders({ health: req.query.health !== 'false' }), checkedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

export default router;
