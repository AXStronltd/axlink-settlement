/**
 * Provider attempt log.
 *
 * Every question we put to a payout partner and every answer we got back.
 *
 * Three things depend on this existing:
 *
 *   - Reconciliation against a partner's monthly statement. Without a record
 *     of what we asked for, a discrepancy is unarguable in their favour.
 *   - Routing decisions grounded in what partners actually do, rather than in
 *     the fee they quote. A partner that quotes cheapest and fails a fifth of
 *     the time is not cheapest.
 *   - Post-incident reconstruction. "The payout failed" is not a finding;
 *     "the partner returned 502 after 4.1s on three consecutive attempts" is.
 *
 * Writes are best-effort and never block a payment: losing an audit row is bad,
 * failing a payment because an audit row could not be written is worse.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../ledger.service';
import type { FundingPlan } from './capability';

export type AttemptOperation = 'QUOTE' | 'PAYOUT' | 'FUND' | 'STATUS';
export type AttemptOutcome = 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'SKIPPED_CIRCUIT_OPEN';

export interface AttemptRecord {
  providerId: string;
  operation: AttemptOperation;
  outcome: AttemptOutcome;
  entityType?: string;
  entityId?: string;
  reference?: string;
  currency?: string;
  amount?: number | Prisma.Decimal;
  plan?: FundingPlan | null;
  latencyMs?: number;
  httpStatus?: number;
  error?: unknown;
  quotedFeeUsd?: number;
  selected?: boolean;
  externalRef?: string;
}

export async function record(attempt: AttemptRecord): Promise<void> {
  try {
    await prisma.providerAttempt.create({
      data: {
        providerId: attempt.providerId,
        operation: attempt.operation,
        outcome: attempt.outcome,
        entityType: attempt.entityType ?? null,
        entityId: attempt.entityId ?? null,
        reference: attempt.reference ?? null,
        currency: attempt.currency ?? null,
        amount: attempt.amount !== undefined ? new Prisma.Decimal(attempt.amount) : null,
        fundingMode: attempt.plan?.mode ?? null,
        settlementCurrency: attempt.plan?.settlementCurrency ?? null,
        latencyMs: attempt.latencyMs ?? null,
        httpStatus: attempt.httpStatus ?? null,
        errorCode: errorCode(attempt.error),
        errorMessage: errorMessage(attempt.error),
        quotedFeeUsd: attempt.quotedFeeUsd !== undefined ? new Prisma.Decimal(attempt.quotedFeeUsd) : null,
        selected: attempt.selected ?? false,
        externalRef: attempt.externalRef ?? null,
      },
    });
  } catch (err) {
    console.warn(`[attempt] could not record ${attempt.providerId}/${attempt.operation}: ${(err as Error).message}`);
  }
}

/**
 * Time an operation and record the outcome either way.
 *
 * Returns the original result, and rethrows the original error — this wraps a
 * call, it does not change its behaviour.
 */
export async function timed<T>(
  meta: Omit<AttemptRecord, 'outcome' | 'latencyMs'>,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    await record({ ...meta, outcome: 'SUCCESS', latencyMs: Date.now() - started });
    return result;
  } catch (err) {
    const status = httpStatus(err);
    await record({
      ...meta,
      outcome: status === 408 ? 'TIMEOUT' : 'FAILURE',
      latencyMs: Date.now() - started,
      httpStatus: status,
      error: err,
    });
    throw err;
  }
}

// ── Reporting ─────────────────────────────────────────────────────────────────

/**
 * Health per provider over a window.
 *
 * `successRate` is over PAYOUT and FUND only. Including QUOTE would flatter a
 * partner that quotes reliably and pays unreliably, which is the failure mode
 * that actually costs money.
 */
export async function providerHealth(windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 3_600_000);

  const rows = await prisma.providerAttempt.groupBy({
    by: ['providerId', 'operation', 'outcome'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _avg: { latencyMs: true },
  });

  const byProvider = new Map<
    string,
    { total: number; money: number; moneySuccess: number; latencySum: number; latencyN: number; outcomes: Record<string, number> }
  >();

  for (const row of rows) {
    const p = byProvider.get(row.providerId) ?? {
      total: 0,
      money: 0,
      moneySuccess: 0,
      latencySum: 0,
      latencyN: 0,
      outcomes: {},
    };

    const n = row._count._all;
    p.total += n;
    p.outcomes[row.outcome] = (p.outcomes[row.outcome] ?? 0) + n;

    if (row.operation === 'PAYOUT' || row.operation === 'FUND') {
      p.money += n;
      if (row.outcome === 'SUCCESS') p.moneySuccess += n;
    }

    if (row._avg.latencyMs) {
      p.latencySum += row._avg.latencyMs * n;
      p.latencyN += n;
    }

    byProvider.set(row.providerId, p);
  }

  return [...byProvider.entries()].map(([providerId, p]) => ({
    providerId,
    windowHours,
    attempts: p.total,
    moneyOperations: p.money,
    successRate: p.money > 0 ? Number((p.moneySuccess / p.money).toFixed(4)) : null,
    avgLatencyMs: p.latencyN > 0 ? Math.round(p.latencySum / p.latencyN) : null,
    outcomes: p.outcomes,
  }));
}

/** Every attempt against one settlement, oldest first. */
export async function attemptsFor(entityType: string, entityId: string) {
  return prisma.providerAttempt.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'asc' },
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  return undefined;
}

function errorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

function errorMessage(err: unknown): string | null {
  if (!err) return null;
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}
