import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the LP registry so quote.service doesn't need real LPs ──────────────

const mockRFQResult = {
  quote: {
    id: 'mock_q_001',
    from: 'GBP',
    to: 'KES',
    fromAmount: 100,
    toAmount: 16380,   // LP's raw rate: 163.80 per GBP
    rate: 163.80,
    validUntil: Date.now() + 30_000,
    source: 'b2binpay',
  },
  winner: { id: 'b2binpay', name: 'B2BinPay' },
  allResponses: [{ lp: 'b2binpay', toAmount: 16380, latencyMs: 45 }],
};

vi.mock('../services/lp-registry.service', () => ({
  broadcastRFQ: vi.fn(async () => mockRFQResult),
  getRegisteredLPs: vi.fn(() => [{ id: 'b2binpay', name: 'B2BinPay' }]),
}));

import { createQuote, getQuote, consumeQuote } from '../core/quote.service';

describe('createQuote', () => {
  it('returns a valid ACTIVE quote', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    expect(q.status).toBe('ACTIVE');
    expect(q.fromCurrency).toBe('GBP');
    expect(q.toCurrency).toBe('KES');
    expect(q.fromAmount).toBe(100);
    expect(q.lpSource).toBe('b2binpay');
  });

  it('toAmount is LP rate minus AxLink spread', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    // GBP:KES spread = 1.8% → customerRate = 163.80 * (1 - 0.018)
    const expectedRate = 163.80 * (1 - 0.018);
    const expectedToAmount = 100 * expectedRate;
    expect(q.rate).toBeCloseTo(expectedRate, 2);
    expect(q.toAmount).toBeCloseTo(expectedToAmount, 1);
    expect(q.toAmount).toBeLessThan(16380); // user gets less than LP's raw rate
  });

  it('platform fee is always 0', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    expect(q.platformFee).toBe(0);
    expect(q.feePct).toBe(0);
  });

  it('usdtAmount equals usdAmount (1:1)', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    expect(q.usdtAmount).toBe(q.usdAmount);
  });

  it('expiresAt is ~30s in the future', async () => {
    const before = Date.now();
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    expect(q.expiresAt).toBeGreaterThanOrEqual(before + 29_900);
    expect(q.expiresAt).toBeLessThanOrEqual(before + 30_100);
  });

  it('margin.profitUsd > 0 (revenue > cost)', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    expect(q.margin.profitUsd).toBeGreaterThan(0);
    expect(q.margin.revenueUsd).toBeGreaterThan(q.margin.costUsd);
  });

  it('throws for fromAmount <= 0', async () => {
    await expect(
      createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 0 })
    ).rejects.toThrow(/greater than 0/i);
  });

  it('same-currency skips RFQ and returns 1:1 rate', async () => {
    const q = await createQuote({ fromCurrency: 'KES', toCurrency: 'KES', fromAmount: 1000 });
    expect(q.fromAmount).toBe(q.toAmount);
    expect(q.rate).toBe(1);
  });

  it('each quote has a unique id', async () => {
    const q1 = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    const q2 = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    expect(q1.id).not.toBe(q2.id);
  });
});

describe('getQuote', () => {
  it('retrieves the quote by id', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 50 });
    const fetched = getQuote(q.id);
    expect(fetched.id).toBe(q.id);
    expect(fetched.fromAmount).toBe(50);
  });

  it('throws for unknown quoteId', () => {
    expect(() => getQuote('nonexistent-uuid')).toThrow(/not found/i);
  });

  it('marks ACTIVE as EXPIRED after expiry', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    // Manually expire it
    (q as { expiresAt: number }).expiresAt = Date.now() - 1;

    const fetched = getQuote(q.id);
    expect(fetched.status).toBe('EXPIRED');
    expect(fetched.expiresInSeconds).toBe(0);
  });
});

describe('consumeQuote', () => {
  it('marks quote as EXECUTED', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    const consumed = consumeQuote(q.id);
    expect(consumed.status).toBe('EXECUTED');
  });

  it('second consume throws double-spend error', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    consumeQuote(q.id);
    expect(() => consumeQuote(q.id)).toThrow(/already used/i);
  });

  it('consuming an expired quote throws', async () => {
    const q = await createQuote({ fromCurrency: 'GBP', toCurrency: 'KES', fromAmount: 100 });
    (q as { expiresAt: number }).expiresAt = Date.now() - 1;
    expect(() => consumeQuote(q.id)).toThrow(/expired/i);
  });
});
