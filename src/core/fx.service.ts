import { Prisma } from '@prisma/client';

// Exact intermediates for database decimals; posting paths reject excess scale instead of rounding.
Prisma.Decimal.set({ precision: 80, rounding: Prisma.Decimal.ROUND_HALF_EVEN });
// AxLink FX Engine — AXSTRON-managed conversion layer.
//
// USD is the internal value unit. All cross-currency conversions route through USD.
// AxLink owns the rate table and spread logic — no external LP computes rates for us.
//
// B2BinPay is a USD LIQUIDITY PARTNER only: when we process a cross-currency
// settlement we ask B2BinPay to provide USD equivalent — they do not compute rates.
//
// Local rails (Daraja, Choice Bank, Brainrock, etc.) handle fiat collection and
// disbursement at the edges — they are not FX providers.
//
// In sandbox: rates from AXLINK_SANDBOX_RATES (mid-market approx June 2025).
// In production: replace liveRates() with a real-time feed (OpenExchangeRates, ECB, etc.)

// ── AxLink rate table: units of currency per 1 USD (mid-market) ───────────────

const AXLINK_SANDBOX_RATES: Record<string, number> = {
  KES:   129.00,   // 1 USD = 129 KES
  UGX:  3745.00,   // 1 USD = 3,745 UGX
  NGN:  1587.00,   // 1 USD = 1,587 NGN
  GHS:    16.10,   // 1 USD = 16.1 GHS
  ZAR:    18.50,   // 1 USD = 18.5 ZAR
  TZS:  2680.00,   // 1 USD = 2,680 TZS
  GBP:     0.787,  // 1 USD = 0.787 GBP
  EUR:     0.926,  // 1 USD = 0.926 EUR
  CAD:     1.370,  // 1 USD = 1.37 CAD
  USD:     1.000,
  USDT:    1.000,  // USD = USDT 1:1 always
};

function usdUnitsFor(currency: string): number {
  const rate = AXLINK_SANDBOX_RATES[currency];
  if (!rate) throw new Error(`AxLink FX: unsupported currency ${currency}`);
  return rate;
}

function normalise(c: string): string {
  return c.toUpperCase()
    .replace('USDC_SOL', 'USDC')
    .replace('USDT_SOL', 'USDT')
    .replace('USDT_TRX', 'USDT')
    .replace('USDT_ERC20', 'USDT');
}

// ── Core rate function ────────────────────────────────────────────────────────
// Returns how many units of `to` you get per 1 unit of `from`.
// Cross-rate via USD: from → USD → to
// 1 fromN = (1 / usdUnits(fromN)) USD = (usdUnits(toN) / usdUnits(fromN)) toN

export async function getRate(from: string, to: string): Promise<number> {
  const fromN = normalise(from);
  const toN   = normalise(to);
  if (fromN === toN) return 1;
  if ((fromN === 'USD' || fromN === 'USDT') && (toN === 'USD' || toN === 'USDT')) return 1;
  return usdUnitsFor(toN) / usdUnitsFor(fromN);
}

// Convert amount from one currency to another
export async function convert(amount: number, from: string, to: string): Promise<number> {
  const rate = await getRate(from, to);
  return parseFloat((amount * rate).toFixed(8));
}

// Convert any amount to USD (AxLink internal value unit)
export async function toUSD(amount: number, currency: string): Promise<number> {
  const fromN = normalise(currency);
  if (fromN === 'USD' || fromN === 'USDT') return amount;
  return parseFloat((amount / usdUnitsFor(fromN)).toFixed(8));
}

/**
 * Exact variant for posting paths (remediation F5): never passes the amount through a JS float.
 * The rate table itself is numeric sandbox data; the division is done in Decimal at 8 dp, the
 * precision of the ledger columns.
 */
export function toUSDDecimal(amount: Prisma.Decimal.Value, currency: string): Prisma.Decimal {
  const fromN = normalise(currency);
  const d = new Prisma.Decimal(amount);
  if (fromN === 'USD' || fromN === 'USDT' || fromN === 'USDC') return d;
  return d.div(new Prisma.Decimal(usdUnitsFor(fromN))).toDecimalPlaces(8);
}

// Convert USD to a local currency
export async function fromUSD(usdAmount: number, currency: string): Promise<number> {
  const toN = normalise(currency);
  if (toN === 'USD' || toN === 'USDT') return usdAmount;
  return parseFloat((usdAmount * usdUnitsFor(toN)).toFixed(8));
}

// USD = USDT 1:1 (Fireblocks USDT vault — AxLink internal transport)
export function usdToUsdt(usdAmount: number): number {
  return usdAmount;
}

// Supported fiat corridors
export const SUPPORTED_CURRENCIES = ['KES', 'NGN', 'GHS', 'ZAR', 'UGX', 'TZS', 'GBP', 'EUR', 'USD'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

// ── AxLink Internal LP ────────────────────────────────────────────────────────
// The built-in fallback LP — always responds to any pair in the rate table.
// Other LPs (B2BinPay, future) can outbid this rate.
// Ensures the RFQ system always has at least one respondent.

import type { ILiquidityProvider, LPRate, LPQuote } from './lp.interface';

const AXLINK_ALL_CURRENCIES = new Set(Object.keys(AXLINK_SANDBOX_RATES));

export const axlinkInternalLP: ILiquidityProvider = {
  id:   'axlink',
  name: 'AxLink Internal',

  supportsRate(from: string, to: string): boolean {
    return AXLINK_ALL_CURRENCIES.has(from.toUpperCase()) && AXLINK_ALL_CURRENCIES.has(to.toUpperCase());
  },

  async getRate(from: string, to: string): Promise<LPRate> {
    const mid    = await getRate(from, to);
    const spread = mid * 0.002;
    const now    = Date.now();
    return { bid: mid - spread, ask: mid + spread, mid, spread: spread * 2, spreadPct: (spread * 2) / mid, fetchedAt: now, source: 'axlink' };
  },

  async requestQuote(from: string, to: string, fromAmount: number): Promise<LPQuote> {
    const mid    = await getRate(from, to);
    const spread = mid * 0.004; // 0.4% axlink internal spread (external LPs often beat this)
    const rate   = mid - spread;
    return {
      id:         `axlink_q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      from:       from.toUpperCase(),
      to:         to.toUpperCase(),
      fromAmount,
      toAmount:   parseFloat((fromAmount * rate).toFixed(8)),
      rate,
      validUntil: Date.now() + 30_000,
      source:     'axlink',
    };
  },
};
