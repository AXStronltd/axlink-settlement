import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  withBreaker,
  breakerState,
  isAvailable,
  resetAllBreakers,
  configureBreakers,
  CircuitOpenError,
  breakerSnapshot,
} from '../core/provider/circuit-breaker';

const fail = () => Promise.reject(new Error('partner down'));
const ok = () => Promise.resolve('paid');

async function trip(providerId: string, times: number) {
  for (let i = 0; i < times; i++) {
    await withBreaker(providerId, fail).catch(() => undefined);
  }
}

describe('circuit breaker', () => {
  beforeEach(() => {
    resetAllBreakers();
    configureBreakers({ failureThreshold: 3, cooldownMs: 1_000, successThreshold: 2, halfOpenMaxConcurrent: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAllBreakers();
  });

  it('starts closed and passes calls through', async () => {
    expect(breakerState('p')).toBe('CLOSED');
    await expect(withBreaker('p', ok)).resolves.toBe('paid');
  });

  it('opens after the configured number of consecutive failures', async () => {
    await trip('p', 3);
    expect(breakerState('p')).toBe('OPEN');
    expect(isAvailable('p')).toBe(false);
  });

  // The behaviour that matters: once open, the partner is not called at all.
  // Previously a down partner was re-raced on every payout, adding the full
  // quote timeout to every payment.
  it('rejects without calling the provider while open', async () => {
    await trip('p', 3);

    const spy = vi.fn(ok);
    await expect(withBreaker('p', spy)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('resets the failure count on an intervening success', async () => {
    await trip('p', 2);
    await withBreaker('p', ok);
    await trip('p', 2);
    expect(breakerState('p')).toBe('CLOSED');
  });

  it('half-opens once the cooldown elapses', async () => {
    vi.useFakeTimers();
    await trip('p', 3);
    expect(breakerState('p')).toBe('OPEN');

    vi.advanceTimersByTime(1_001);
    expect(breakerState('p')).toBe('HALF_OPEN');
    expect(isAvailable('p')).toBe(true);
  });

  it('closes after enough consecutive probe successes', async () => {
    vi.useFakeTimers();
    await trip('p', 3);
    vi.advanceTimersByTime(1_001);

    await withBreaker('p', ok);
    expect(breakerState('p')).toBe('HALF_OPEN');
    await withBreaker('p', ok);
    expect(breakerState('p')).toBe('CLOSED');
  });

  // A single failed probe re-opens immediately — a partner that is still broken
  // should not get a second full round of traffic to prove it.
  it('re-opens on a single failed probe', async () => {
    vi.useFakeTimers();
    await trip('p', 3);
    vi.advanceTimersByTime(1_001);
    expect(breakerState('p')).toBe('HALF_OPEN');

    await withBreaker('p', fail).catch(() => undefined);
    expect(breakerState('p')).toBe('OPEN');
  });

  it('keeps providers isolated from each other', async () => {
    await trip('broken', 3);
    expect(breakerState('broken')).toBe('OPEN');
    expect(breakerState('healthy')).toBe('CLOSED');
    await expect(withBreaker('healthy', ok)).resolves.toBe('paid');
  });

  it('propagates the provider error unchanged when closed', async () => {
    await expect(withBreaker('p', fail)).rejects.toThrow('partner down');
  });

  it('reports state and the last error for the ops endpoint', async () => {
    await trip('p', 3);
    const snapshot = breakerSnapshot().find(s => s.providerId === 'p');
    expect(snapshot).toMatchObject({ state: 'OPEN', consecutiveFailures: 3, lastError: 'partner down' });
    expect(snapshot?.totalFailures).toBe(3);
  });
});
