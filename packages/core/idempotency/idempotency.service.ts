/**
 * Idempotency for money-moving endpoints.
 *
 * The existing `checkIdempotency` in `interbank.service.ts` reads for an
 * existing row and then writes if it finds none. Two concurrent requests with
 * the same reference both read nothing, both pass, and both settle. There was
 * also no unique constraint backing it, so nothing stopped them.
 *
 * The fix is to let the database arbitrate: `create` on a unique key. Exactly
 * one caller wins the insert; everyone else gets a constraint violation and is
 * routed to the replay path.
 *
 * Three outcomes a caller must handle:
 *
 *   EXECUTED   this request won — run the work
 *   REPLAYED   a previous identical request completed — return its response
 *   CONFLICT   same key, different body, or a request still in flight
 */

import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../ledger/ledger.service';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a row may sit IN_FLIGHT before a retry is allowed to take it over.
 *
 * This is a liveness/safety trade with real money on it. Too short and a slow
 * but healthy request gets duplicated; too long and a genuinely crashed request
 * blocks the caller from retrying. Five minutes comfortably exceeds any of our
 * partner timeouts, so a row still IN_FLIGHT after that means the process
 * holding it is gone.
 */
const STALE_IN_FLIGHT_MS = 5 * 60 * 1000;

export type IdempotencyScope = 'withdrawal' | 'p2p' | 'interbank' | 'deposit' | 'settlement';

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly statusCode = 409;
  constructor(message: string, readonly existingEntityId?: string) {
    super(message);
  }
}

export class RequestInFlightError extends Error {
  readonly code = 'REQUEST_IN_FLIGHT';
  readonly statusCode = 409;
  constructor(scope: string, key: string) {
    super(
      `A request with idempotency key '${key}' (${scope}) is still in flight. ` +
      `Retry after it settles — do not resubmit with a new key, which would pay twice.`,
    );
  }
}

/**
 * Canonical hash of the request body.
 *
 * Keys are sorted so that `{a,b}` and `{b,a}` hash the same, and `undefined`
 * is dropped so an explicitly-absent optional field matches an omitted one.
 */
export function hashRequest(body: unknown): string {
  return createHash('sha256').update(canonicalize(body)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export interface IdempotentResult<T> {
  outcome: 'EXECUTED' | 'REPLAYED';
  value: T;
  entityId?: string;
}

/**
 * Run `work` at most once for a given (scope, key).
 *
 * `work` receives a `claim()` callback: call it as soon as the durable entity
 * exists (a Withdrawal row, say) so that a crash mid-flight still leaves a
 * pointer to what was created. Without it a crashed request is indistinguishable
 * from one that never started, and the safe response to that ambiguity is to
 * refuse the retry — which strands the customer.
 */
export async function withIdempotency<T>(
  params: {
    scope: IdempotencyScope;
    key: string;
    request: unknown;
    ttlMs?: number;
  },
  work: (ctx: { claim: (entityType: string, entityId: string) => Promise<void> }) => Promise<T>,
): Promise<IdempotentResult<T>> {
  const { scope, key } = params;
  const requestHash = hashRequest(params.request);
  const expiresAt = new Date(Date.now() + (params.ttlMs ?? DEFAULT_TTL_MS));

  // Try to claim the key. Exactly one concurrent caller can win this insert.
  try {
    await prisma.idempotencyKey.create({
      data: { scope, key, requestHash, status: 'IN_FLIGHT', expiresAt },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return handleExisting<T>(scope, key, requestHash, expiresAt, work);
  }

  return execute<T>(scope, key, work);
}

async function handleExisting<T>(
  scope: IdempotencyScope,
  key: string,
  requestHash: string,
  expiresAt: Date,
  work: (ctx: { claim: (entityType: string, entityId: string) => Promise<void> }) => Promise<T>,
): Promise<IdempotentResult<T>> {
  const existing = await prisma.idempotencyKey.findUniqueOrThrow({
    where: { scope_key: { scope, key } },
  });

  // Same key, different request. Almost always a client bug — reusing a
  // reference for a different payment. Never serve the cached response for a
  // body we did not see.
  if (existing.requestHash !== requestHash) {
    throw new IdempotencyConflictError(
      `Idempotency key '${key}' (${scope}) was already used for a different request. ` +
      `Reusing a key with changed parameters is unsafe — use a new key.`,
      existing.entityId ?? undefined,
    );
  }

  if (existing.status === 'COMPLETED') {
    return {
      outcome: 'REPLAYED',
      value: existing.responseBody as T,
      entityId: existing.entityId ?? undefined,
    };
  }

  if (existing.status === 'FAILED') {
    // A genuine failure is retryable: reopen the claim and run again.
    await prisma.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: { status: 'IN_FLIGHT', failureCode: null, expiresAt },
    });
    return execute<T>(scope, key, work);
  }

  // IN_FLIGHT. If the holder is gone, take it over; otherwise refuse.
  const age = Date.now() - existing.updatedAt.getTime();
  if (age > STALE_IN_FLIGHT_MS) {
    console.warn(
      `[idempotency] Taking over stale IN_FLIGHT ${scope}:${key} (${Math.round(age / 1000)}s old, ` +
      `entity ${existing.entityType ?? '?'}:${existing.entityId ?? '?'})`,
    );
    await prisma.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: { status: 'IN_FLIGHT', expiresAt },
    });
    return execute<T>(scope, key, work);
  }

  throw new RequestInFlightError(scope, key);
}

async function execute<T>(
  scope: IdempotencyScope,
  key: string,
  work: (ctx: { claim: (entityType: string, entityId: string) => Promise<void> }) => Promise<T>,
): Promise<IdempotentResult<T>> {
  const claim = async (entityType: string, entityId: string) => {
    await prisma.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: { entityType, entityId },
    });
  };

  try {
    const value = await work({ claim });

    const row = await prisma.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: { status: 'COMPLETED', responseBody: value as Prisma.InputJsonValue },
    });

    return { outcome: 'EXECUTED', value, entityId: row.entityId ?? undefined };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'UNKNOWN';
    await prisma.idempotencyKey
      .update({ where: { scope_key: { scope, key } }, data: { status: 'FAILED', failureCode: code } })
      .catch(() => {
        /* best effort — the original error is what matters */
      });
    throw err;
  }
}

/** Housekeeping: drop expired keys. Safe to run on a schedule. */
export async function pruneExpired(): Promise<number> {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() }, status: { not: 'IN_FLIGHT' } },
  });
  return count;
}
