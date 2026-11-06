import { describe, it, expect } from 'vitest';
import { formatUnits, parseUnits, commitmentReached, SOLANA_MINTS, SETTLEMENT_ASSET } from '../../packages/providers/blockchain/solana/solana';
import { hashRequest } from '../../packages/core/idempotency/idempotency.service';
import { backoffDelay, defaultIsRetryable } from '../../packages/providers/runtime/retry';

// Amounts are converted between decimal strings and integer base units on the
// settlement path. Doing that in floating point is how a settlement proof ends
// up disagreeing with the chain by a rounding error, so it is done in BigInt.
describe('unit conversion', () => {
  it('round-trips USDT amounts exactly', () => {
    for (const value of ['0', '1', '0.000001', '1234.567891', '999999999.999999']) {
      expect(formatUnits(parseUnits(value, 6), 6)).toBe(value);
    }
  });

  it('parses to the correct base units', () => {
    expect(parseUnits('1', 6)).toBe(1_000_000n);
    expect(parseUnits('0.5', 6)).toBe(500_000n);
    expect(parseUnits('1234.56', 6)).toBe(1_234_560_000n);
  });

  it('truncates beyond the mint precision rather than rounding up', () => {
    // Rounding up would create value that does not exist on chain.
    expect(parseUnits('1.9999999', 6)).toBe(1_999_999n);
  });

  it('formats negative amounts', () => {
    expect(formatUnits(-1_500_000n, 6)).toBe('-1.5');
  });

  it('strips trailing zeros without losing the value', () => {
    expect(formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatUnits(1_000_000n, 6)).toBe('1');
  });

  it('survives amounts beyond IEEE-754 integer precision', () => {
    const huge = '9007199254740993.123456'; // > Number.MAX_SAFE_INTEGER
    expect(formatUnits(parseUnits(huge, 6), 6)).toBe(huge);
  });
});

describe('commitment ordering', () => {
  it('treats finalized as satisfying every lower commitment', () => {
    expect(commitmentReached('finalized', 'confirmed')).toBe(true);
    expect(commitmentReached('finalized', 'finalized')).toBe(true);
  });

  // Only `finalized` is settlement — anything less can still be rolled back.
  it('does not accept confirmed as final', () => {
    expect(commitmentReached('confirmed', 'finalized')).toBe(false);
    expect(commitmentReached('processed', 'finalized')).toBe(false);
  });
});

describe('mint registry', () => {
  it('settles in USDT by default', () => {
    expect(SETTLEMENT_ASSET).toBe('USDT');
    expect(SOLANA_MINTS[SETTLEMENT_ASSET]).toBeDefined();
  });

  it('uses six decimals for both settlement assets', () => {
    expect(SOLANA_MINTS.USDC.decimals).toBe(6);
    expect(SOLANA_MINTS.USDT.decimals).toBe(6);
  });

  it('has distinct mint addresses', () => {
    expect(SOLANA_MINTS.USDC.mint).not.toBe(SOLANA_MINTS.USDT.mint);
  });
});

describe('idempotency request hashing', () => {
  it('is stable across key order', () => {
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
  });

  it('treats an explicit undefined as absent', () => {
    expect(hashRequest({ a: 1, b: undefined })).toBe(hashRequest({ a: 1 }));
  });

  // The check that stops a client reusing a reference for a different payment.
  it('changes when any value changes', () => {
    expect(hashRequest({ amount: 100 })).not.toBe(hashRequest({ amount: 100.01 }));
    expect(hashRequest({ amount: 100 })).not.toBe(hashRequest({ amount: '100' }));
  });

  it('is order-sensitive for arrays, which are ordered', () => {
    expect(hashRequest({ x: [1, 2] })).not.toBe(hashRequest({ x: [2, 1] }));
  });

  it('recurses into nested objects', () => {
    expect(hashRequest({ d: { a: 1, b: 2 } })).toBe(hashRequest({ d: { b: 2, a: 1 } }));
    expect(hashRequest({ d: { a: 1 } })).not.toBe(hashRequest({ d: { a: 2 } }));
  });
});

describe('retry policy', () => {
  it('retries transient server and transport failures', () => {
    expect(defaultIsRetryable({ statusCode: 503 })).toBe(true);
    expect(defaultIsRetryable({ statusCode: 429 })).toBe(true);
    expect(defaultIsRetryable({ code: 'ECONNRESET' })).toBe(true);
  });

  it('does not retry a client error that will fail identically', () => {
    expect(defaultIsRetryable({ statusCode: 400 })).toBe(false);
    expect(defaultIsRetryable({ statusCode: 422 })).toBe(false);
  });

  // The breaker has already made this decision; retrying past it defeats it.
  it('does not retry past an open circuit', () => {
    expect(defaultIsRetryable({ code: 'PROVIDER_CIRCUIT_OPEN' })).toBe(false);
  });

  it('does not retry a corridor that has no funding route', () => {
    expect(defaultIsRetryable({ code: 'NO_FUNDING_ROUTE' })).toBe(false);
  });

  it('honours an explicit retryable flag over the status code', () => {
    expect(defaultIsRetryable({ statusCode: 400, retryable: true })).toBe(true);
    expect(defaultIsRetryable({ statusCode: 503, retryable: false })).toBe(false);
  });

  it('keeps full-jitter backoff inside its ceiling', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ceiling = Math.min(4_000, 250 * 2 ** attempt);
      for (let i = 0; i < 50; i++) {
        const delay = backoffDelay(attempt, 250, 4_000);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  // Without jitter every client retries in lockstep, which is how a partner
  // that just came back up goes down again.
  it('produces varied delays rather than a fixed schedule', () => {
    const seen = new Set(Array.from({ length: 60 }, () => backoffDelay(5, 250, 4_000)));
    expect(seen.size).toBeGreaterThan(5);
  });
});
