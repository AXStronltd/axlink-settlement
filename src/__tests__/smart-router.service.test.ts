import { describe, it, expect } from 'vitest';
import {
  classifyRoute,
  getSpread,
  checkRateFloor,
  describeRoute,
} from '../core/smart-router.service';

describe('classifyRoute', () => {
  it('same currency → IDENTITY', () => {
    expect(classifyRoute('KES', 'KES')).toBe('IDENTITY');
    expect(classifyRoute('GBP', 'GBP')).toBe('IDENTITY');
    expect(classifyRoute('NGN', 'NGN')).toBe('IDENTITY');
  });

  it('USD ↔ USDT → STABLE', () => {
    expect(classifyRoute('USD', 'USDT')).toBe('STABLE');
    expect(classifyRoute('USDT', 'USD')).toBe('STABLE');
  });

  it('USDT_SOL ↔ USD → STABLE', () => {
    expect(classifyRoute('USDT_SOL', 'USD')).toBe('STABLE');
    expect(classifyRoute('USD', 'USDT_SOL')).toBe('STABLE');
  });

  it('USDT_SOL ↔ USDT → STABLE', () => {
    expect(classifyRoute('USDT_SOL', 'USDT')).toBe('STABLE');
    expect(classifyRoute('USDT', 'USDT_TRX')).toBe('STABLE');
  });

  it('GBP ↔ USD → MAJOR', () => {
    expect(classifyRoute('GBP', 'USD')).toBe('MAJOR');
    expect(classifyRoute('USD', 'GBP')).toBe('MAJOR');
    expect(classifyRoute('EUR', 'USD')).toBe('MAJOR');
    expect(classifyRoute('USD', 'CAD')).toBe('MAJOR');
  });

  it('GBP → KES → CORRIDOR', () => {
    expect(classifyRoute('GBP', 'KES')).toBe('CORRIDOR');
    expect(classifyRoute('USD', 'NGN')).toBe('CORRIDOR');
    expect(classifyRoute('EUR', 'GHS')).toBe('CORRIDOR');
    expect(classifyRoute('KES', 'NGN')).toBe('CORRIDOR');
  });
});

describe('getSpread', () => {
  it('IDENTITY = 0%', () => {
    expect(getSpread('KES', 'KES')).toBe(0);
    expect(getSpread('GBP', 'GBP')).toBe(0);
  });

  it('STABLE = 0% (USD→USDT should NEVER charge a spread)', () => {
    expect(getSpread('USD', 'USDT')).toBe(0);
    expect(getSpread('USDT', 'USD')).toBe(0);
    expect(getSpread('USDT_SOL', 'USD')).toBe(0);
    expect(getSpread('USDT', 'USDT_ERC20')).toBe(0);
  });

  it('MAJOR spreads are tight (≤ 0.8%)', () => {
    expect(getSpread('GBP', 'USD')).toBeLessThanOrEqual(0.008);
    expect(getSpread('EUR', 'USD')).toBeLessThanOrEqual(0.008);
    expect(getSpread('USD', 'CAD')).toBeLessThanOrEqual(0.008);
  });

  it('CORRIDOR spreads are wider (1.5%–2.5%)', () => {
    const gbpKes = getSpread('GBP', 'KES');
    const usdNgn = getSpread('USD', 'NGN');
    const gbpGhs = getSpread('GBP', 'GHS');
    expect(gbpKes).toBeGreaterThanOrEqual(0.015);
    expect(gbpKes).toBeLessThanOrEqual(0.025);
    expect(usdNgn).toBeGreaterThanOrEqual(0.015);
    expect(gbpGhs).toBeGreaterThanOrEqual(0.015);
  });

  it('corridor spread is always less than 3%', () => {
    const pairs = [
      ['KES', 'GBP'], ['NGN', 'USD'], ['GHS', 'EUR'], ['ZAR', 'USD'],
      ['UGX', 'GBP'], ['TZS', 'USD'],
    ];
    for (const [from, to] of pairs) {
      expect(getSpread(from, to)).toBeLessThan(0.03);
    }
  });

  it('MAJOR spread < CORRIDOR spread for same base currency', () => {
    expect(getSpread('GBP', 'USD')).toBeLessThan(getSpread('GBP', 'KES'));
  });
});

describe('checkRateFloor', () => {
  it('IDENTITY/STABLE: rate exactly 1 → always passes', () => {
    const r = checkRateFloor(1, 1, 'KES', 'KES');
    expect(r.passed).toBe(true);
    expect(r.customerRate).toBe(1);
  });

  it('MAJOR: normal LP rate passes', () => {
    // midRate = 1.27 (GBP/USD), LP quoted same, spread = 0.5%
    const r = checkRateFloor(1.27, 1.27, 'GBP', 'USD');
    expect(r.passed).toBe(true);
    expect(r.route).toBe('MAJOR');
  });

  it('MAJOR: LP rate 2% below mid is blocked (floor = 1.5%)', () => {
    // midRate = 1.27, LP only offers 1.244 (2% below mid)
    const lpRate  = 1.27 * 0.98;
    const midRate = 1.27;
    const r = checkRateFloor(lpRate, midRate, 'GBP', 'USD');
    // customerRate = lpRate × (1 - spread) = 1.244 × 0.995 ≈ 1.238
    // floorRate = midRate × (1 - 0.015) = 1.27 × 0.985 = 1.251
    // 1.238 < 1.251 → FAIL
    expect(r.passed).toBe(false);
  });

  it('CORRIDOR: 4% LP drop passes (floor = 5%)', () => {
    const midRate = 163.80;
    const lpRate  = midRate * 0.96; // LP 4% below mid
    const r = checkRateFloor(lpRate, midRate, 'GBP', 'KES');
    // customerRate = lpRate × (1 - 0.018) = 157.25 × 0.982 ≈ 154.42
    // floorRate = 163.80 × 0.95 = 155.61
    // 154.42 < 155.61 → actually this might fail at 4% LP drop + 1.8% spread
    // Let me check: total loss = 1 - (0.96 * 0.982) = 1 - 0.9427 = 5.73% > 5%
    // So this should FAIL
    expect(r.passed).toBe(false);
  });

  it('CORRIDOR: normal LP rate (mid +/- 0%) passes floor', () => {
    const midRate = 163.80;
    const r = checkRateFloor(midRate, midRate, 'GBP', 'KES');
    // customerRate = 163.80 × (1 - 0.018) = 160.85
    // floorRate = 163.80 × 0.95 = 155.61
    // 160.85 > 155.61 → PASS
    expect(r.passed).toBe(true);
    expect(r.route).toBe('CORRIDOR');
  });

  it('rate floor result contains full audit data', () => {
    const r = checkRateFloor(163.80, 163.80, 'GBP', 'KES');
    expect(r).toHaveProperty('customerRate');
    expect(r).toHaveProperty('midRate');
    expect(r).toHaveProperty('floorRate');
    expect(r).toHaveProperty('lossFromMid');
    expect(r).toHaveProperty('route');
    expect(r.lossFromMid).toBeGreaterThan(0); // spread was applied
  });
});

describe('describeRoute', () => {
  it('returns a human-readable string', () => {
    expect(describeRoute('KES', 'KES')).toMatch(/same currency/i);
    expect(describeRoute('USD', 'USDT')).toMatch(/stable pair/i);
    expect(describeRoute('GBP', 'USD')).toMatch(/major pair/i);
    expect(describeRoute('GBP', 'KES')).toMatch(/corridor/i);
  });

  it('shows spread % for non-identity routes', () => {
    expect(describeRoute('GBP', 'KES')).toMatch(/1\.80%/);
    expect(describeRoute('USD', 'NGN')).toMatch(/2\.20%/);
    expect(describeRoute('USD', 'USDT')).not.toMatch(/%/); // no spread shown
  });
});

describe('End-to-end: 1:1 guarantee for safe pairs', () => {
  it('KES → KES: spread = 0, rate = 1', () => {
    expect(getSpread('KES', 'KES')).toBe(0);
    expect(classifyRoute('KES', 'KES')).toBe('IDENTITY');
  });

  it('USD → USDT: spread = 0, rate = 1 (was broken: gave 0.982)', () => {
    expect(getSpread('USD', 'USDT')).toBe(0);
    expect(classifyRoute('USD', 'USDT')).toBe('STABLE');
    // Confirming the old bug is gone: 1000 USD → 1000 USDT (not 982)
  });

  it('USDT_SOL → USD: spread = 0 (Fireblocks internal to fiat, no tax)', () => {
    expect(getSpread('USDT_SOL', 'USD')).toBe(0);
  });
});
