/**
 * Bounded retry with exponential backoff and full jitter.
 *
 * Deliberately narrow: retrying a payment is how you pay twice. Only pass
 * operations that are idempotent at the partner — either because the partner
 * keys on our reference, or because the operation is a read.
 *
 * Non-retryable by default:
 *   - 4xx responses other than 408 (request timeout) and 429 (rate limited).
 *     A 400/401/403/422 will fail identically on retry.
 *   - `CircuitOpenError` — the breaker already decided; retrying defeats it.
 *   - Anything the caller marks with `retryable: false`.
 */

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Override the default classifier. Return false to fail fast. */
  isRetryable?: (err: unknown) => boolean;
  /** Called before each retry — used to write the attempt log. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Abort signal so a retry loop cannot outlive its request. */
  signal?: AbortSignal;
}

const DEFAULTS = {
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Status code from the shapes our HTTP layers actually produce. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  const response = e.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  return undefined;
}

export function defaultIsRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;

  if (e.retryable === false) return false;
  if (e.retryable === true) return true;

  // The breaker has already made this decision.
  if (e.code === 'PROVIDER_CIRCUIT_OPEN') return false;
  // A funding plan that does not exist will not start existing.
  if (e.code === 'NO_FUNDING_ROUTE') return false;

  const status = statusOf(err);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);

  // Transport-level failures — safe to retry an idempotent call.
  const code = typeof e.code === 'string' ? e.code : '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Retry aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('Retry aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Full-jitter backoff (AWS architecture blog): `random(0, min(max, base * 2^n))`.
 * Uncapped exponential without jitter makes every client retry in lockstep,
 * which is how a partner that just came back up goes down again.
 */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isLast = attempt === attempts - 1;
      if (isLast || !isRetryable(err)) throw err;

      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.(err, attempt + 1, delay);
      await sleep(delay, options.signal);
    }
  }

  throw lastError;
}

/**
 * Reject if `fn` has not settled within `ms`.
 *
 * Note the caveat that matters for money: a timeout tells you the call did not
 * *answer* in time, not that it did not *happen*. Never treat a timeout on a
 * payout as a failed payout — reconcile it.
 */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { statusCode: 408 })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
