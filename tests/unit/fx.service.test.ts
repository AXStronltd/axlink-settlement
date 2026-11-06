import { describe, it, expect } from 'vitest';
import { getRate, convert, toUSD, fromUSD, usdToUsdt, SUPPORTED_CURRENCIES } from '../../packages/settlement/fx-quotes/fx.service';

describe('getRate', () => {
  it('same currency returns 1', async () => {
    expect(await getRate('KES', 'KES')).toBe(1);
    expect(await getRate('GBP', 'GBP')).toBe(1);
  });

  it('USD/USDT pair returns 1', async () => {
    expect(await getRate('USD', 'USDT')).toBe(1);
    expect(await getRate('USDT', 'USD')).toBe(1);
  });

  it('USD → KES uses sandbox rate (129)', async () => {
    expect(await getRate('USD', 'KES')).toBe(129);
  });

  it('KES → USD is inverse of USD → KES', async () => {
    const r = await getRate('KES', 'USD');
    expect(r).toBeCloseTo(1 / 129, 6);
  });

  it('GBP → KES cross-rate: KES/GBP ÷ ... = 129/0.787', async () => {
    const r = await getRate('GBP', 'KES');
    expect(r).toBeCloseTo(129 / 0.787, 2);
  });

  it('EUR → NGN cross-rate', async () => {
    const r = await getRate('EUR', 'NGN');
    expect(r).toBeCloseTo(1587 / 0.926, 1);
  });

  it('normalises USDT_SOL to USDT', async () => {
    expect(await getRate('USDT_SOL', 'KES')).toBe(129);
  });

  it('normalises USDT_ERC20 to USDT', async () => {
    expect(await getRate('KES', 'USDT_ERC20')).toBeCloseTo(1 / 129, 6);
  });

  it('throws for unsupported currency', async () => {
    await expect(getRate('XYZ', 'USD')).rejects.toThrow('unsupported currency XYZ');
  });
});

describe('convert', () => {
  it('converts GBP to KES', async () => {
    const result = await convert(100, 'GBP', 'KES');
    expect(result).toBeCloseTo(100 * (129 / 0.787), 1);
  });

  it('same currency returns same amount', async () => {
    expect(await convert(500, 'USD', 'USD')).toBe(500);
  });

  it('rounds to 8 decimal places', async () => {
    const result = await convert(1, 'KES', 'USD');
    const decimals = result.toString().split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(8);
  });
});

describe('toUSD', () => {
  it('USD stays USD', async () => {
    expect(await toUSD(100, 'USD')).toBe(100);
  });

  it('USDT stays USD', async () => {
    expect(await toUSD(100, 'USDT')).toBe(100);
  });

  it('1000 KES ≈ 7.75 USD', async () => {
    const result = await toUSD(1000, 'KES');
    expect(result).toBeCloseTo(1000 / 129, 4);
  });

  it('100 GBP to USD', async () => {
    const result = await toUSD(100, 'GBP');
    expect(result).toBeCloseTo(100 / 0.787, 4);
  });
});

describe('fromUSD', () => {
  it('USD stays USD', async () => {
    expect(await fromUSD(100, 'USD')).toBe(100);
  });

  it('100 USD → KES', async () => {
    const result = await fromUSD(100, 'KES');
    expect(result).toBe(12900);
  });
});

describe('usdToUsdt', () => {
  it('is always 1:1', () => {
    expect(usdToUsdt(123.456)).toBe(123.456);
    expect(usdToUsdt(0)).toBe(0);
  });
});

describe('SUPPORTED_CURRENCIES', () => {
  it('contains all expected currencies', () => {
    for (const ccy of ['KES', 'NGN', 'GHS', 'ZAR', 'UGX', 'TZS', 'GBP', 'EUR', 'USD']) {
      expect(SUPPORTED_CURRENCIES).toContain(ccy);
    }
  });
});
