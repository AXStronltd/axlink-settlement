/**
 * Settlement legs — the crash-recovery layer.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  THE PROBLEM THIS SOLVES
 *
 *  A withdrawal does: debit ledger (committed) → move USDT at the custodian
 *  (network) → convert to fiat (network) → pay the partner (network) →
 *  update status (committed). If the process dies at any point in the
 *  middle, the customer has been debited and nothing will ever revisit the
 *  payment. The only recovery path in the codebase is a webhook that may
 *  never arrive.
 *
 *  The deposit path has the same shape plus a sequencing bug: it asks
 *  B2BinPay to convert fiat→USDT and then, in the same function, immediately
 *  requests a USDT payout to the user's vault — before the conversion has
 *  happened and before the USDT exists. Correct sequencing requires waiting
 *  on the conversion, and waiting requires somewhere durable to wait.
 *
 *  So: write down each step before doing it, record its outcome, and let a
 *  worker pick up anything left in a non-terminal state.
 * ══════════════════════════════════════════════════════════════════════
 *
 * A leg is idempotent by `externalKey`: the key handed to the external system
 * is derived from the leg's identity, so a resumed leg reuses the same request
 * rather than creating a second payment.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../ledger.service';

export type LegKind =
  | 'LEDGER_DEBIT'
  | 'LEDGER_CREDIT'
  | 'CONVERT_FIAT_TO_CRYPTO'
  | 'CONVERT_CRYPTO_TO_FIAT'
  | 'CUSTODY_TRANSFER'
  | 'ONCHAIN_SETTLE'
  | 'PARTNER_PAYOUT'
  | 'COMPENSATE';

export type LegStatus =
  | 'PENDING'
  | 'IN_FLIGHT'
  | 'AWAITING_CONFIRMATION'
  | 'COMPLETED'
  | 'FAILED'
  | 'COMPENSATED'
  | 'ABANDONED';

const TERMINAL: ReadonlySet<LegStatus> = new Set<LegStatus>([
  'COMPLETED',
  'COMPENSATED',
  'ABANDONED',
]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status as LegStatus);
}

/**
 * Legal transitions. Enforced rather than documented, because the interesting
 * bugs are the ones where a leg goes COMPLETED → IN_FLIGHT and pays twice.
 */
const TRANSITIONS: Record<LegStatus, LegStatus[]> = {
  PENDING: ['IN_FLIGHT', 'ABANDONED'],
  IN_FLIGHT: ['AWAITING_CONFIRMATION', 'COMPLETED', 'FAILED'],
  AWAITING_CONFIRMATION: ['COMPLETED', 'FAILED', 'AWAITING_CONFIRMATION'],
  FAILED: ['IN_FLIGHT', 'COMPENSATED', 'ABANDONED'],
  COMPLETED: [],
  COMPENSATED: [],
  ABANDONED: [],
};

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_LEG_TRANSITION';
  constructor(legId: string, from: string, to: string) {
    super(`Leg ${legId} cannot move ${from} → ${to}`);
  }
}

// ── Planning ──────────────────────────────────────────────────────────────────

export interface LegSpec {
  kind: LegKind;
  asset?: string;
  amount?: Prisma.Decimal | number | string;
  payload?: Prisma.InputJsonValue;
  maxAttempts?: number;
}

/**
 * Write the plan before executing any of it.
 *
 * Called inside the same transaction that creates the domain record, so there
 * is never a Withdrawal without a plan attached. Idempotent: replaying a plan
 * returns the existing legs.
 */
export async function planLegs(
  tx: Prisma.TransactionClient,
  entityType: string,
  entityId: string,
  specs: LegSpec[],
): Promise<void> {
  const existing = await tx.settlementLeg.count({ where: { entityType, entityId } });
  if (existing > 0) return;

  await tx.settlementLeg.createMany({
    data: specs.map((spec, sequence) => ({
      entityType,
      entityId,
      sequence,
      kind: spec.kind,
      status: 'PENDING',
      // Deterministic, so a resumed leg reuses the same external request.
      externalKey: `${entityType}:${entityId}:${sequence}:${spec.kind}`,
      asset: spec.asset ?? null,
      amount: spec.amount !== undefined ? new Prisma.Decimal(spec.amount) : null,
      payload: spec.payload ?? undefined,
      maxAttempts: spec.maxAttempts ?? 5,
    })),
  });
}

// ── Execution ─────────────────────────────────────────────────────────────────

export interface LegOutcome {
  /** COMPLETED when the external system is done; AWAITING_CONFIRMATION when a webhook or on-chain check is still owed. */
  status: 'COMPLETED' | 'AWAITING_CONFIRMATION';
  externalRef?: string;
  payload?: Prisma.InputJsonValue;
}

/**
 * Run one leg, with attempt accounting and transition enforcement.
 *
 * `run` receives the leg's `externalKey` and must pass it to the external
 * system as its idempotency key or client reference. That is what makes a
 * retry safe: the partner recognises the repeat and returns the original
 * result instead of creating a second payment.
 */
export async function executeLeg(
  legId: string,
  run: (leg: { externalKey: string; payload: unknown; amount: Prisma.Decimal | null; asset: string | null }) => Promise<LegOutcome>,
): Promise<{ status: LegStatus; externalRef?: string }> {
  const leg = await prisma.settlementLeg.findUniqueOrThrow({ where: { id: legId } });

  if (isTerminal(leg.status)) {
    return { status: leg.status as LegStatus, externalRef: leg.externalRef ?? undefined };
  }

  assertTransition(leg.id, leg.status as LegStatus, 'IN_FLIGHT');

  await prisma.settlementLeg.update({
    where: { id: legId },
    data: { status: 'IN_FLIGHT', attempts: { increment: 1 }, lastError: null },
  });

  try {
    const outcome = await run({
      externalKey: leg.externalKey,
      payload: leg.payload,
      amount: leg.amount,
      asset: leg.asset,
    });

    await prisma.settlementLeg.update({
      where: { id: legId },
      data: {
        status: outcome.status,
        externalRef: outcome.externalRef ?? leg.externalRef,
        payload: outcome.payload ?? undefined,
        completedAt: outcome.status === 'COMPLETED' ? new Date() : null,
        nextAttemptAt:
          outcome.status === 'AWAITING_CONFIRMATION' ? new Date(Date.now() + confirmationDelayMs(0)) : null,
      },
    });

    return { status: outcome.status, externalRef: outcome.externalRef };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Some failures are permanent: the chain moved the wrong amount, the asset
    // was not what we expected. Retrying asks the same question and gets the
    // same answer, while the customer's money sits in suspense. An error that
    // says retryable: false is taken at its word and the budget is spent at
    // once, so compensation runs now rather than four delays from now.
    const permanent = (err as { retryable?: boolean }).retryable === false;
    const attempts = permanent ? leg.maxAttempts : leg.attempts + 1;
    const exhausted = permanent || attempts >= leg.maxAttempts;

    await prisma.settlementLeg.update({
      where: { id: legId },
      data: {
        status: 'FAILED',
        attempts,
        lastError: message.slice(0, 2000),
        nextAttemptAt: exhausted ? null : new Date(Date.now() + retryDelayMs(attempts)),
      },
    });

    if (exhausted) {
      console.error(
        `[leg] ${leg.entityType}:${leg.entityId} leg ${leg.sequence} (${leg.kind}) exhausted ` +
        `${leg.maxAttempts} attempts — needs manual intervention. Last error: ${message}`,
      );
    }

    throw err;
  }
}

/**
 * Find a leg by the key we handed the external system.
 *
 * Every leg passes its `externalKey` as the partner's tracking id, so a
 * callback carrying that id can be matched back to the leg that caused it
 * without threading our own identifiers through their API.
 */
export async function legByExternalKey(externalKey: string) {
  return prisma.settlementLeg.findFirst({ where: { externalKey } });
}

/**
 * Merge fields into a leg's payload.
 *
 * Callbacks carry data the *next* leg needs — most importantly the on-chain
 * hash, which arrives on the custody callback and is what ONCHAIN_SETTLE
 * verifies. Merges rather than replaces: the payload also holds routing
 * information written when the leg was planned.
 */
export async function mergeLegPayload(legId: string, patch: Prisma.InputJsonObject): Promise<void> {
  const leg = await prisma.settlementLeg.findUniqueOrThrow({ where: { id: legId } });
  const merged = { ...((leg.payload as Prisma.InputJsonObject) ?? {}), ...patch };
  await prisma.settlementLeg.update({
    where: { id: legId },
    data: { payload: merged as Prisma.InputJsonValue },
  });
}

/** Mark a leg awaiting confirmation as settled, once the confirmation arrives. */
export async function confirmLeg(legId: string, externalRef?: string): Promise<void> {
  const leg = await prisma.settlementLeg.findUniqueOrThrow({ where: { id: legId } });
  if (isTerminal(leg.status)) return;
  assertTransition(leg.id, leg.status as LegStatus, 'COMPLETED');

  await prisma.settlementLeg.update({
    where: { id: legId },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      nextAttemptAt: null,
      externalRef: externalRef ?? leg.externalRef,
    },
  });
}

/** Record that a leg was undone by a compensating action. */
export async function compensateLeg(legId: string, note: string): Promise<void> {
  const leg = await prisma.settlementLeg.findUniqueOrThrow({ where: { id: legId } });
  if (isTerminal(leg.status)) return;

  await prisma.settlementLeg.update({
    where: { id: legId },
    data: { status: 'COMPENSATED', lastError: note.slice(0, 2000), nextAttemptAt: null },
  });
}

function assertTransition(legId: string, from: LegStatus, to: LegStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) throw new IllegalTransitionError(legId, from, to);
}

/** Exponential with a ceiling, jittered so retries do not synchronise. */
function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(15 * 60_000, 5_000 * 2 ** (attempt - 1));
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

/** Confirmation polls start fast — Solana finality is seconds, not minutes. */
function confirmationDelayMs(poll: number): number {
  return Math.min(60_000, 3_000 * 2 ** poll);
}

// ── Queries used by the resume worker and ops ─────────────────────────────────

/** Legs that are due for another attempt. */
export async function dueLegs(limit = 50) {
  return prisma.settlementLeg.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED', 'AWAITING_CONFIRMATION'] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      attempts: { lt: prisma.settlementLeg.fields.maxAttempts },
    },
    orderBy: [{ createdAt: 'asc' }],
    take: limit,
  });
}

/**
 * Legs that have exhausted their retries and need a human.
 *
 * This is the queue that must be empty at the start of every day. A settlement
 * that lands here has customer money in an indeterminate state.
 */
export async function stuckLegs() {
  return prisma.settlementLeg.findMany({
    where: {
      status: { in: ['FAILED', 'IN_FLIGHT', 'AWAITING_CONFIRMATION'] },
      attempts: { gte: prisma.settlementLeg.fields.maxAttempts },
    },
    orderBy: { updatedAt: 'asc' },
  });
}

/** All legs for one settlement, in order. */
export async function legsFor(entityType: string, entityId: string) {
  return prisma.settlementLeg.findMany({
    where: { entityType, entityId },
    orderBy: { sequence: 'asc' },
  });
}

/** The next leg that should run for this settlement, or null when all are done. */
export async function nextLeg(entityType: string, entityId: string) {
  const legs = await legsFor(entityType, entityId);
  return legs.find(l => !isTerminal(l.status)) ?? null;
}

/** True when every leg reached COMPLETED. */
export async function isSettled(entityType: string, entityId: string): Promise<boolean> {
  const legs = await legsFor(entityType, entityId);
  return legs.length > 0 && legs.every(l => l.status === 'COMPLETED');
}
