/**
 * Resume worker.
 *
 * The reason the leg state machine is worth having: something has to actually
 * drive stalled settlements forward. Without this, a settlement that stops
 * between the customer debit and the partner payout stays stopped until a
 * person notices.
 *
 * Runs in-process on an interval. That is a deliberate choice for this stage —
 * it needs no extra infrastructure, and correctness does not depend on it
 * being singleton, because every leg is idempotent on its `externalKey`. If two
 * instances pick up the same leg, the second one's external call is recognised
 * as a repeat by the partner rather than creating a second payment.
 *
 * When this moves to multiple instances and the duplicate *calls* (not
 * duplicate payments) become wasteful, add `SELECT … FOR UPDATE SKIP LOCKED`
 * over the due-legs query. The correctness argument does not change; only the
 * efficiency one does.
 */

import { prisma } from '../ledger.service';
import { dueLegs, stuckLegs } from './leg.service';
import { advanceDeposit, advanceWithdrawal } from './usd-corridor.service';

const TICK_MS = Number(process.env.SETTLEMENT_WORKER_INTERVAL_MS ?? 15_000);
const BATCH = Number(process.env.SETTLEMENT_WORKER_BATCH ?? 25);

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export interface TickResult {
  examined: number;
  advanced: number;
  errors: number;
  stuck: number;
}

/**
 * One pass over everything due.
 *
 * Failures are logged and counted, never thrown: one poisoned settlement must
 * not stop the worker from servicing the rest.
 */
export async function tick(): Promise<TickResult> {
  const legs = await dueLegs(BATCH);
  const result: TickResult = { examined: legs.length, advanced: 0, errors: 0, stuck: 0 };

  // Group by settlement — advancing one leg often unblocks the next, so doing
  // the whole entity once is both cheaper and closer to the real sequence.
  const entities = new Map<string, { type: string; id: string }>();
  for (const leg of legs) {
    entities.set(`${leg.entityType}:${leg.entityId}`, { type: leg.entityType, id: leg.entityId });
  }

  for (const { type, id } of entities.values()) {
    try {
      if (type === 'BankDeposit') await advanceDeposit(id);
      else if (type === 'Withdrawal') await advanceWithdrawal(id);
      else continue;
      result.advanced += 1;
    } catch (err) {
      result.errors += 1;
      console.warn(`[worker] ${type}:${id} did not advance — ${(err as Error).message}`);
    }
  }

  const stuck = await stuckLegs();
  result.stuck = stuck.length;

  if (stuck.length > 0) {
    // Loud on purpose. Every row here is a settlement whose money is in an
    // indeterminate state and which no amount of retrying will fix.
    console.error(
      `[worker] ${stuck.length} leg(s) have exhausted their retries and need manual review: ` +
      stuck.slice(0, 5).map(l => `${l.entityType}:${l.entityId}#${l.sequence}(${l.kind})`).join(', ') +
      (stuck.length > 5 ? ` … and ${stuck.length - 5} more` : ''),
    );
  }

  return result;
}

export function startResumeWorker(): void {
  if (timer) return;

  console.log(`[worker] settlement resume worker started — every ${TICK_MS}ms, batch ${BATCH}`);

  timer = setInterval(() => {
    // Skip rather than queue: a slow tick means the system is busy, and piling
    // overlapping passes on top of it makes that worse.
    if (running) return;
    running = true;
    tick()
      .then(r => {
        if (r.advanced > 0 || r.errors > 0) {
          console.log(`[worker] examined ${r.examined}, advanced ${r.advanced}, errors ${r.errors}`);
        }
      })
      .catch(err => console.error('[worker] tick failed:', err))
      .finally(() => {
        running = false;
      });
  }, TICK_MS);

  timer.unref?.();
}

export function stopResumeWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Ops view: what is in flight and what needs a human. */
export async function workerStatus() {
  const [byStatus, stuck] = await Promise.all([
    prisma.settlementLeg.groupBy({ by: ['status'], _count: { _all: true } }),
    stuckLegs(),
  ]);

  return {
    running: timer !== null,
    intervalMs: TICK_MS,
    legs: Object.fromEntries(byStatus.map(g => [g.status, g._count._all])),
    needsIntervention: stuck.map(l => ({
      entity: `${l.entityType}:${l.entityId}`,
      sequence: l.sequence,
      kind: l.kind,
      status: l.status,
      attempts: l.attempts,
      lastError: l.lastError,
      since: l.updatedAt,
    })),
  };
}
