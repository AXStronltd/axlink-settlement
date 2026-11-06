/**
 * Provider events — exactly-once processing (remediation F1).
 *
 * The rule: a provider event may change financial state at most once, whatever the delivery
 * pattern (replay, delayed retry, concurrent duplicates). The mechanism is a database uniqueness
 * constraint, not a read-then-write check:
 *
 *   1. Inside ONE transaction, insert ProviderEvent(provider, eventId). The unique index makes a
 *      concurrent duplicate block on the first insert and then fail with P2002 once it commits.
 *   2. In the same transaction, apply the effects (ledger posting, status change).
 *   3. If anything throws, the whole transaction — including the event row — rolls back, so a
 *      failed attempt can be retried and a successful one can never be repeated.
 *
 * A duplicate is acknowledged (HTTP 200, `duplicate: true`) so the provider stops retrying.
 */
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../ledger.service';
import { log } from '../../platform/logger';

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface EventRecord {
  provider: 'fireblocks' | 'b2binpay';
  /** Provider's id for this exact event — tx id + status, so a later status for the same tx is a new event. */
  eventId: string;
  kind?: string;
  rawBody: string;
}

export interface EventOutcome {
  status: 'PROCESSED' | 'IGNORED' | 'REJECTED';
  reason?: string;
  assetId?: string | null;
  institutionId?: string | null;
  vaultId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

export type ProcessResult<T> =
  | { duplicate: true; outcome?: undefined; result?: undefined }
  | { duplicate: false; outcome: EventOutcome; result: T };

export class EventIgnored extends Error {
  constructor(public readonly outcome: EventOutcome) { super(outcome.reason ?? 'ignored'); }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/**
 * Run `apply` exactly once for `event`. `apply` receives the transaction and returns the outcome
 * plus a result. Throwing `EventIgnored` records the event as IGNORED/REJECTED (nothing else is
 * written); any other throw rolls everything back and propagates.
 */
export async function processOnce<T>(
  event: EventRecord,
  apply: (tx: Tx) => Promise<{ outcome: EventOutcome; result: T }>,
): Promise<ProcessResult<T>> {
  const payloadHash = crypto.createHash('sha256').update(event.rawBody).digest('hex');
  const base = { provider: event.provider, eventId: event.eventId, kind: event.kind ?? null, payloadHash };

  try {
    const applied = await prisma.$transaction(async (tx) => {
      // Claim first. A concurrent duplicate waits here until this transaction commits or aborts.
      const row = await tx.providerEvent.create({ data: { ...base, status: 'PROCESSED' } });
      // Any throw below (EventIgnored included) aborts the transaction: the claim, the posting and
      // the status change all disappear together.
      const { outcome, result } = await apply(tx);
      await tx.providerEvent.update({ where: { id: row.id }, data: outcomeData(outcome) });
      return { outcome, result };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { duplicate: false, ...applied };
  } catch (e) {
    if (isUniqueViolation(e)) {
      log.info('provider_event.duplicate', { provider: event.provider, eventId: event.eventId });
      return { duplicate: true };
    }
    if (e instanceof EventIgnored) {
      // Main transaction rolled back (no financial effect). Record the ignore outside it; a
      // concurrent duplicate racing this insert just becomes a duplicate.
      await prisma.providerEvent
        .create({ data: { ...base, ...outcomeData(e.outcome) } })
        .catch((err: unknown) => { if (!isUniqueViolation(err)) throw err; });
      log.warn('provider_event.ignored', { provider: event.provider, eventId: event.eventId, reason: e.outcome.reason });
      return { duplicate: false, outcome: e.outcome, result: undefined as unknown as T };
    }
    throw e;
  }
}

function outcomeData(o: EventOutcome) {
  return {
    status: o.status, reason: o.reason ?? null, assetId: o.assetId ?? null, institutionId: o.institutionId ?? null,
    vaultId: o.vaultId ?? null, entityType: o.entityType ?? null, entityId: o.entityId ?? null,
  };
}
