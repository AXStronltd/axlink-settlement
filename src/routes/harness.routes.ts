/**
 * Settlement harness over HTTP — scenario runner plus a live console.
 *
 * Two modes:
 *
 *   /run, /scenarios       the same suite as `npm run simulate`, for proving an
 *                          environment works without shelling into it
 *   /session/*, /act/*     a live stub session you drive by hand from /console,
 *                          for watching movements before anything goes live
 *
 * Not to be confused with `simulate.routes.ts`, which builds an illustrative
 * narrative for the frontend and never touches the engine. These run real
 * settlements: real ledger, real legs, real proof verification.
 *
 * Mounted only when SIMULATOR_ENABLED=true and NODE_ENV is not production, and
 * every route below requires OPS_API_KEY.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { run, cleanupOrphans, SCENARIOS, SimulatorRefused } from '../simulator/runner';
import * as session from '../simulator/session';
import { prisma } from '../core/ledger.service';
import { addFunds, withdraw, advanceDeposit, advanceWithdrawal, confirmPartnerPayout } from '../core/settlement/usd-corridor.service';
import { legsFor, stuckLegs } from '../core/settlement/leg.service';
import { tick } from '../core/settlement/resume.worker';
import { trialBalance } from '../core/settlement/journal.service';
import { proofsFor } from '../core/settlement/proof.service';
import { checkAll, postingsFor } from '../simulator/invariants';

// Express 5 types route params as `string | string[]` because a wildcard
// segment can repeat. Same helper as settlement.routes.ts — narrow once here
// rather than casting at each call site.
const param = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

const router = Router();

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireOpsKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.OPS_API_KEY ?? '';
  if (!expected) {
    res.status(503).json({ error: 'OPS_API_KEY is not configured — harness endpoints are disabled' });
    return;
  }
  // The console passes the key as a query param on the page load and then as a
  // header; accept both so the page can be opened from a bookmark.
  const provided =
    (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') ||
    String(req.query.key ?? '');

  let diff = provided.length ^ expected.length;
  for (let i = 0; i < Math.min(provided.length, expected.length); i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

router.use(requireOpsKey);

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

// ── Scenario suite ────────────────────────────────────────────────────────────

router.get('/scenarios', (_req, res) => {
  res.json({
    count: SCENARIOS.length,
    scenarios: SCENARIOS.map(s => ({ id: s.id, title: s.title, proves: s.proves })),
  });
});

router.post('/run', (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body ?? {}) as { only?: string[] | string; keepData?: boolean };
  const only = Array.isArray(body.only) ? body.only : body.only ? [body.only] : undefined;

  run({ only, keepData: body.keepData === true })
    .then(report => {
      // Status carries the result so CI can gate without parsing the body.
      res.status(report.passed ? 200 : 422).json(report);
    })
    .catch(err => {
      if (err instanceof SimulatorRefused) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    });
});

router.post('/cleanup', wrap(async (_req, res) => res.json({ ok: true, removed: await cleanupOrphans() })));

// ── Live session ──────────────────────────────────────────────────────────────

router.get('/session', (_req, res) => res.json(session.info()));

router.post('/session/start', (_req, res, next) => {
  try {
    res.json(session.start());
  } catch (err) {
    if (err instanceof SimulatorRefused) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
});

router.post(
  '/session/stop',
  wrap(async (req, res) => res.json(await session.stop({ keepData: req.body?.keepData === true }))),
);

router.post(
  '/session/faults',
  wrap(async (req, res) => res.json({ faults: session.setFaults((req.body ?? {}) as Record<string, never>) })),
);

router.post('/session/faults/clear', wrap(async (_req, res) => res.json({ faults: session.clearFaults() })));

// ── Actions ───────────────────────────────────────────────────────────────────

router.post(
  '/act/user',
  wrap(async (req, res) => res.json(await session.createUser(req.body ?? {}))),
);

router.post(
  '/act/deposit',
  wrap(async (req, res) => {
    const { userId, amount } = req.body ?? {};
    const result = await addFunds({
      userId: String(userId),
      amount: Number(amount),
      rail: 'console',
      railReference: `console_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
    const depositId = (result.value as { depositId: string }).depositId;
    session.trackDeposit(depositId);
    res.json({ outcome: result.outcome, ...(result.value as object) });
  }),
);

router.post(
  '/act/withdraw',
  wrap(async (req, res) => {
    const { userId, amount, idempotencyKey } = req.body ?? {};
    const result = await withdraw({
      userId: String(userId),
      amount: Number(amount),
      providerId: 'console-partner',
      partnerAccount: 'GB00CONSOLE0000000',
      recipientName: String(req.body?.recipientName ?? 'Console Beneficiary'),
      // A caller-supplied key is how you test replay from the console: send the
      // same one twice and watch the second come back REPLAYED.
      idempotencyKey: String(idempotencyKey || `console_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    });
    const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
    session.trackWithdrawal(withdrawalId);
    res.json({ outcome: result.outcome, ...(result.value as object) });
  }),
);

router.post(
  '/act/advance',
  wrap(async (req, res) => {
    const { entityType, entityId } = req.body ?? {};
    if (entityType === 'BankDeposit') await advanceDeposit(String(entityId));
    else if (entityType === 'Withdrawal') await advanceWithdrawal(String(entityId));
    else {
      res.status(400).json({ error: `Cannot advance '${entityType}'` });
      return;
    }
    res.json({ ok: true, legs: await legsFor(String(entityType), String(entityId)) });
  }),
);

/** One pass of the resume worker — the "what would recovery do" button. */
router.post('/act/tick', wrap(async (_req, res) => res.json(await tick())));

router.post(
  '/act/confirm',
  wrap(async (req, res) => {
    const { withdrawalId, partnerReference } = req.body ?? {};
    await confirmPartnerPayout(String(withdrawalId), String(partnerReference || `console-ref-${Date.now()}`));
    res.json({ ok: true });
  }),
);

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * Everything the console shows, in one request.
 *
 * Deliberately one call rather than six: the console polls, and six endpoints
 * polled independently produce a view where the balance is from one moment and
 * the legs from another — which looks exactly like a bug.
 */
router.get(
  '/state',
  wrap(async (_req, res) => {
    const scope = session.currentScopeSafe();
    const entityIds = [...scope.depositIds, ...scope.withdrawalIds];

    const [subjects, deposits, withdrawals, tb, stuck] = await Promise.all([
      session.isActive() ? session.subjects() : Promise.resolve([]),
      scope.depositIds.length
        ? prisma.bankDeposit.findMany({ where: { id: { in: scope.depositIds } }, orderBy: { createdAt: 'desc' } })
        : Promise.resolve([]),
      scope.withdrawalIds.length
        ? prisma.withdrawal.findMany({ where: { id: { in: scope.withdrawalIds } }, orderBy: { createdAt: 'desc' } })
        : Promise.resolve([]),
      trialBalance(),
      stuckLegs(),
    ]);

    const legs = entityIds.length
      ? await prisma.settlementLeg.findMany({
          where: { entityId: { in: entityIds } },
          orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }],
        })
      : [];

    const proofs = entityIds.length
      ? await prisma.settlementProof.findMany({
          where: { entityId: { in: entityIds } },
          orderBy: { verifiedAt: 'desc' },
        })
      : [];

    const invariants = session.isActive() ? await checkAll(scope) : [];

    res.json({
      session: session.info(),
      subjects,
      settlements: [
        ...deposits.map(d => ({
          type: 'BankDeposit' as const,
          id: d.id,
          trackingId: d.trackingId,
          userId: d.userId,
          amount: d.amount.toString(),
          currency: d.currency,
          status: d.status,
          createdAt: d.createdAt,
        })),
        ...withdrawals.map(w => ({
          type: 'Withdrawal' as const,
          id: w.id,
          trackingId: w.trackingId,
          userId: w.userId,
          amount: w.amount.toString(),
          currency: w.currency,
          status: w.status,
          createdAt: w.createdAt,
        })),
      ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      legs: legs.map(l => ({
        entityType: l.entityType,
        entityId: l.entityId,
        sequence: l.sequence,
        kind: l.kind,
        status: l.status,
        asset: l.asset,
        amount: l.amount?.toString() ?? null,
        attempts: l.attempts,
        maxAttempts: l.maxAttempts,
        externalRef: l.externalRef,
        lastError: l.lastError,
      })),
      proofs: proofs.map(p => ({
        entityId: p.entityId,
        signature: p.signature,
        slot: p.slot.toString(),
        commitment: p.commitment,
        amount: p.amount.toString(),
        feeLamports: p.feeLamports?.toString() ?? null,
        onchainError: p.onchainError,
      })),
      trialBalance: tb.map(r => ({
        currency: r.currency,
        debits: r.debits.toString(),
        credits: r.credits.toString(),
        residual: r.residual.toString(),
        balanced: r.balanced,
      })),
      invariants,
      stuck: stuck.length,
      calls: session.isActive() ? session.calls(40) : [],
    });
  }),
);

/** The journal for one settlement — opened on demand, not polled. */
router.get(
  '/postings/:entityType/:entityId',
  wrap(async (req, res) =>
    res.json({ postings: await postingsFor(param(req.params.entityType), param(req.params.entityId)) }),
  ),
);

router.get(
  '/proof/:entityType/:entityId',
  wrap(async (req, res) => res.json({ proofs: await proofsFor(param(req.params.entityType), param(req.params.entityId)) })),
);

export default router;
