import { describe, it, expect, vi } from 'vitest';
import type { ILiquidityProvider, LPRate, LPQuote } from '../core/lp.interface';

// Kafka mock — broadcastRFQ emits a fallback event; mock prevents real bus init
vi.mock('../core/kafka.service', () => ({
  getEventBus: vi.fn(async () => ({ publish: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() })),
  TOPICS: { PAYMENT_SETTLED: 'fincruise.payment.settled', PAYMENT_FAILED: 'fincruise.payment.failed' },
}));

function makeLP(id: string, toAmountOverride?: number, delayMs = 0): ILiquidityProvider {
  return {
    id,
    name: `LP-${id}`,
    supportsRate: () => true,
    getRate: async (): Promise<LPRate> => ({ bid: 1, ask: 1, mid: 1, spread: 0, spreadPct: 0, fetchedAt: Date.now(), source: id }),
    requestQuote: async (from, to, fromAmount): Promise<LPQuote> => {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      return {
        id: `${id}_q`,
        from,
        to,
        fromAmount,
        toAmount: toAmountOverride ?? fromAmount,
        rate: toAmountOverride ? toAmountOverride / fromAmount : 1,
        validUntil: Date.now() + 30_000,
        source: id,
      };
    },
  };
}

async function freshRegistry() {
  vi.resetModules();
  return import('../core/lp-registry.service');
}

describe('registerLP', () => {
  it('registers an LP and lists it', async () => {
    const { registerLP, getRegisteredLPs } = await freshRegistry();
    registerLP(makeLP('alpha'));
    const lps = getRegisteredLPs();
    expect(lps.some(l => l.id === 'alpha')).toBe(true);
  });

  it('is idempotent — same LP registered twice = one entry', async () => {
    const { registerLP, getRegisteredLPs } = await freshRegistry();
    const lp = makeLP('beta');
    registerLP(lp);
    registerLP(lp);
    expect(getRegisteredLPs().filter(l => l.id === 'beta').length).toBe(1);
  });
});

describe('broadcastRFQ — winner selection', () => {
  it('selects LP with highest toAmount', async () => {
    const { registerLP, broadcastRFQ } = await freshRegistry();
    registerLP(makeLP('low',  100));
    registerLP(makeLP('high', 200));
    registerLP(makeLP('mid',  150));

    const { winner, quote } = await broadcastRFQ('USD', 'KES', 1);
    expect(winner.id).toBe('high');
    expect(quote.toAmount).toBe(200);
  });

  it('returns allResponses with one entry per LP', async () => {
    const { registerLP, broadcastRFQ } = await freshRegistry();
    registerLP(makeLP('lp1', 10));
    registerLP(makeLP('lp2', 20));

    const { allResponses } = await broadcastRFQ('GBP', 'KES', 1);
    expect(allResponses.length).toBe(2);
    expect(allResponses.every(r => r.lp && r.latencyMs >= 0)).toBe(true);
  });

  it('partial failure — surviving LP still wins', async () => {
    const failing: ILiquidityProvider = {
      ...makeLP('fail', 999),
      requestQuote: async () => { throw new Error('LP down'); },
    };
    const working = makeLP('working', 50);

    const { registerLP, broadcastRFQ } = await freshRegistry();
    registerLP(failing);
    registerLP(working);

    const { winner } = await broadcastRFQ('EUR', 'NGN', 100);
    expect(winner.id).toBe('working');
  });

  it('all LPs fail → throws', async () => {
    const f1: ILiquidityProvider = { ...makeLP('f1'), requestQuote: async () => { throw new Error('down'); } };
    const f2: ILiquidityProvider = { ...makeLP('f2'), requestQuote: async () => { throw new Error('down'); } };

    const { registerLP, broadcastRFQ } = await freshRegistry();
    registerLP(f1);
    registerLP(f2);

    await expect(broadcastRFQ('GBP', 'KES', 100)).rejects.toThrow(/all lps failed/i);
  });

  it('no supported LP → throws', async () => {
    const { broadcastRFQ } = await freshRegistry();
    // No LPs registered for this pair
    await expect(broadcastRFQ('BTC', 'ETH', 1)).rejects.toThrow(/no lp registered/i);
  });

  it('slow LP is timed out and fast LP wins instead', async () => {
    const fast = makeLP('fast', 80, 0);       // responds immediately
    const slow = makeLP('slow', 9999, 800);   // 800ms > 600ms RFQ_TIMEOUT_MS

    const { registerLP, broadcastRFQ } = await freshRegistry();
    registerLP(fast);
    registerLP(slow);

    const start = Date.now();
    const { winner, allResponses } = await broadcastRFQ('USD', 'KES', 1);

    const elapsed = Date.now() - start;
    expect(winner.id).toBe('fast');          // fast wins (slow was dropped)
    expect(elapsed).toBeLessThan(750);       // whole RFQ completed in < 750ms
    const slowResponse = allResponses.find(r => r.lp === 'slow');
    expect(slowResponse?.error).toMatch(/timed out/i);
  }, 5000);
});

describe('getBestRate', () => {
  it('returns rate from highest-bidding LP', async () => {
    const { registerLP, getBestRate } = await freshRegistry();
    registerLP({
      ...makeLP('lp_rate'),
      getRate: async (): Promise<LPRate> => ({ bid: 150, ask: 152, mid: 151, spread: 2, spreadPct: 0.013, fetchedAt: Date.now(), source: 'lp_rate' }),
    });

    const { rate } = await getBestRate('USD', 'KES');
    expect(rate.mid).toBe(151);
  });
});
