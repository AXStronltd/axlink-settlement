/**
 * Per-provider circuit breaker.
 *
 * Without this, `getBestProvider` races every registered partner on every
 * payout with a 4s timeout. A partner that is down therefore adds 4s of
 * latency to every single payment until someone notices and comments it out of
 * the bootstrap file.
 *
 * States:
 *
 *   CLOSED     normal — calls pass through, failures counted
 *   OPEN       partner is failing — calls rejected immediately, no network hit
 *   HALF_OPEN  cooldown elapsed — let a limited number of probes through;
 *              a success closes the breaker, a failure re-opens it
 *
 * In-process and intentionally so: each instance protects its own event loop
 * from its own slow calls. Cross-instance health belongs in the persisted
 * `ProviderAttempt` log, which is what the ops endpoint reports on.
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerConfig {
  /** Consecutive failures before the breaker opens. */
  failureThreshold: number;
  /** How long to stay open before allowing probes, in ms. */
  cooldownMs: number;
  /** Consecutive probe successes required to close from HALF_OPEN. */
  successThreshold: number;
  /** Concurrent probes allowed while HALF_OPEN. */
  halfOpenMaxConcurrent: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  successThreshold: 2,
  halfOpenMaxConcurrent: 1,
};

interface BreakerRecord {
  state: BreakerState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: number;
  halfOpenInFlight: number;
  lastError?: string;
  totalCalls: number;
  totalFailures: number;
}

export class CircuitOpenError extends Error {
  readonly code = 'PROVIDER_CIRCUIT_OPEN';
  readonly statusCode = 503;
  constructor(readonly providerId: string, retryInMs: number, lastError?: string) {
    super(
      `Provider '${providerId}' circuit is open (retry in ${Math.ceil(retryInMs / 1000)}s)` +
      (lastError ? ` — last error: ${lastError}` : ''),
    );
  }
}

const registry = new Map<string, BreakerRecord>();
let config: BreakerConfig = { ...DEFAULT_BREAKER_CONFIG };

export function configureBreakers(overrides: Partial<BreakerConfig>): void {
  config = { ...config, ...overrides };
}

function record(providerId: string): BreakerRecord {
  let r = registry.get(providerId);
  if (!r) {
    r = {
      state: 'CLOSED',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      openedAt: 0,
      halfOpenInFlight: 0,
      totalCalls: 0,
      totalFailures: 0,
    };
    registry.set(providerId, r);
  }
  return r;
}

/**
 * Current state, transitioning OPEN → HALF_OPEN when the cooldown has elapsed.
 * Safe to call as a predicate — it does not consume a probe slot.
 */
export function breakerState(providerId: string): BreakerState {
  const r = record(providerId);
  if (r.state === 'OPEN' && Date.now() - r.openedAt >= config.cooldownMs) {
    r.state = 'HALF_OPEN';
    r.consecutiveSuccesses = 0;
    r.halfOpenInFlight = 0;
  }
  return r.state;
}

/** True when a call to this provider should be attempted right now. */
export function isAvailable(providerId: string): boolean {
  const state = breakerState(providerId);
  if (state === 'CLOSED') return true;
  if (state === 'OPEN') return false;
  return record(providerId).halfOpenInFlight < config.halfOpenMaxConcurrent;
}

function onSuccess(r: BreakerRecord, providerId: string): void {
  r.consecutiveFailures = 0;
  if (r.state === 'HALF_OPEN') {
    r.consecutiveSuccesses += 1;
    if (r.consecutiveSuccesses >= config.successThreshold) {
      r.state = 'CLOSED';
      r.consecutiveSuccesses = 0;
      console.log(`[breaker] ${providerId} recovered — circuit CLOSED`);
    }
  }
}

function onFailure(r: BreakerRecord, providerId: string, err: unknown): void {
  r.totalFailures += 1;
  r.consecutiveSuccesses = 0;
  r.consecutiveFailures += 1;
  r.lastError = err instanceof Error ? err.message : String(err);

  const shouldOpen =
    r.state === 'HALF_OPEN' || r.consecutiveFailures >= config.failureThreshold;

  if (shouldOpen && r.state !== 'OPEN') {
    r.state = 'OPEN';
    r.openedAt = Date.now();
    console.warn(
      `[breaker] ${providerId} circuit OPEN after ${r.consecutiveFailures} ` +
      `consecutive failures — last: ${r.lastError}`,
    );
  }
}

/**
 * Run `fn` under this provider's breaker.
 *
 * Rejects with `CircuitOpenError` without calling `fn` when the circuit is
 * open. That error is deliberately distinguishable so the registry can skip
 * the provider rather than reporting it as a payout failure.
 */
export async function withBreaker<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
  const state = breakerState(providerId);
  const r = record(providerId);

  if (state === 'OPEN') {
    throw new CircuitOpenError(providerId, config.cooldownMs - (Date.now() - r.openedAt), r.lastError);
  }
  if (state === 'HALF_OPEN') {
    if (r.halfOpenInFlight >= config.halfOpenMaxConcurrent) {
      throw new CircuitOpenError(providerId, config.cooldownMs, r.lastError);
    }
    r.halfOpenInFlight += 1;
  }

  r.totalCalls += 1;

  try {
    const result = await fn();
    onSuccess(r, providerId);
    return result;
  } catch (err) {
    onFailure(r, providerId, err);
    throw err;
  } finally {
    if (r.halfOpenInFlight > 0 && state === 'HALF_OPEN') r.halfOpenInFlight -= 1;
  }
}

/** Snapshot for the ops health endpoint. */
export function breakerSnapshot(): Array<{
  providerId: string;
  state: BreakerState;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  lastError?: string;
  reopensInMs?: number;
}> {
  return [...registry.entries()].map(([providerId, r]) => ({
    providerId,
    state: breakerState(providerId),
    consecutiveFailures: r.consecutiveFailures,
    totalCalls: r.totalCalls,
    totalFailures: r.totalFailures,
    lastError: r.lastError,
    reopensInMs:
      r.state === 'OPEN' ? Math.max(0, config.cooldownMs - (Date.now() - r.openedAt)) : undefined,
  }));
}

/** Force a breaker closed. Ops escape hatch after a partner confirms recovery. */
export function resetBreaker(providerId: string): void {
  registry.delete(providerId);
}

/** Test helper — clears all breaker state. */
export function resetAllBreakers(): void {
  registry.clear();
  config = { ...DEFAULT_BREAKER_CONFIG };
}
