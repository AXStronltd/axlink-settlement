import { getRates } from './b2binpay.service';

// USD is the base — USDT is 1:1 with USD always
const USD_PAIRS = ['USD', 'USDT'];

interface RateEntry {
  rate: number;
  expiresAt: number;
}

const rateCache = new Map<string, RateEntry>();
const CACHE_TTL_MS = 30_000; // 30 seconds (B2BinPay caches server-side too)

function cacheKey(from: string, to: string) {
  return `${from}:${to}`;
}

// Returns how many units of `to` you get per 1 unit of `from`
export async function getRate(from: string, to: string): Promise<number> {
  const fromN = normalise(from);
  const toN = normalise(to);

  if (fromN === toN) return 1;

  // USD ↔ USDT always 1:1
  if (USD_PAIRS.includes(fromN) && USD_PAIRS.includes(toN)) return 1;

  const key = cacheKey(fromN, toN);
  const cached = rateCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.rate;

  // Fetch from B2BinPay — they quote as left/right
  // e.g. left=GBP right=USDT → bid/ask are GBP per USDT
  const left = fromN === 'USDT' || fromN === 'USD' ? toN : fromN;
  const res = await getRates([left]) as {
    data?: { attributes?: { left: string; right: string; bid: string; ask: string } }[]
  };

  const items = res.data ?? [];
  let rate = 1;

  for (const item of items) {
    const a = item.attributes;
    if (!a) continue;
    const mid = (parseFloat(a.bid) + parseFloat(a.ask)) / 2;

    // B2BinPay returns: left=GBP, right=USDT, bid/ask = price of 1 GBP in USDT
    const k1 = cacheKey(a.left, a.right);
    const k2 = cacheKey(a.right, a.left);
    const exp = Date.now() + CACHE_TTL_MS;

    rateCache.set(k1, { rate: mid, expiresAt: exp });
    rateCache.set(k2, { rate: 1 / mid, expiresAt: exp });

    if (k1 === key || (a.left === fromN && a.right === toN)) rate = mid;
    if (k2 === key || (a.right === fromN && a.left === toN)) rate = 1 / mid;
  }

  return rate;
}

// Convert amount from one currency to another
export async function convert(amount: number, from: string, to: string): Promise<number> {
  const rate = await getRate(from, to);
  return parseFloat((amount * rate).toFixed(8));
}

// Convert any currency to USD base
export async function toUSD(amount: number, currency: string): Promise<number> {
  return convert(amount, currency, 'USD');
}

// Convert USD base to local currency
export async function fromUSD(usdAmount: number, currency: string): Promise<number> {
  return convert(usdAmount, 'USD', currency);
}

// USD = USDT 1:1 always
export function usdToUsdt(usdAmount: number): number {
  return usdAmount;
}

function normalise(c: string): string {
  return c.toUpperCase().replace('USDT_SOL', 'USDT').replace('USDT_TRX', 'USDT').replace('USDT_ERC20', 'USDT');
}

// Supported fiat currencies
export const SUPPORTED_CURRENCIES = ['KES', 'NGN', 'GHS', 'ZAR', 'UGX', 'TZS', 'GBP', 'EUR', 'USD'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];
