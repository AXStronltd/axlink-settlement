import { randomUUID } from 'crypto';
import { getRates } from './b2binpay.service';
import { toUSD, usdToUsdt } from './fx.service';

// ── Config ────────────────────────────────────────────────────────────────────

const QUOTE_TTL_MS   = 30_000;
const RATE_CACHE_MS  = 10_000;

// ── FinCruse Revenue Model ────────────────────────────────────────────────────
//
// FinCruse does NOT charge a per-transaction fee to users.
// Revenue = FX spread markup baked into the rate shown to users.
//
// Flow:
//   1. B2BinPay gives FinCruse the institutional mid-market rate (very tight spread)
//   2. FinCruse adds a small spread markup → this is the rate the user sees
//   3. User sees a clean rate with NO fee line — like a traditional bank
//   4. B2BinPay charges FinCruse per transaction at institutional grade
//   5. FinCruse profit = spread revenue - B2BinPay institutional fee

// FinCruse markup on top of B2BinPay institutional rate (corridor-specific)
const SPREAD_MARKUP: Record<string, number> = {
  'USD:KES': 0.018,   // 1.8% spread on USD→KES corridor
  'USD:NGN': 0.022,   // 2.2% — higher risk corridor
  'USD:GHS': 0.020,
  'USD:UGX': 0.020,
  'USD:TZS': 0.020,
  'USD:ZAR': 0.015,
  'GBP:KES': 0.018,
  'GBP:NGN': 0.022,
  'GBP:GHS': 0.020,
  'EUR:KES': 0.018,
  'EUR:NGN': 0.022,
  'GBP:USD': 0.008,   // major pair — tighter spread
  'USD:GBP': 0.008,
  'USD:EUR': 0.008,
  'EUR:USD': 0.008,
  'USD:USD': 0.005,
};

// B2BinPay institutional cost per transaction
const B2B_INSTITUTIONAL_PCT = 0.003;   // ~0.3% institutional spread from B2BinPay
const SOLANA_GAS_USD        = 0.00025; // Solana transaction gas

function getSpreadMarkup(from: string, to: string): number {
  return SPREAD_MARKUP[`${from}:${to}`] ?? 0.018;
}

function getTraditionalComparison(from: string, to: string): { provider: string; totalCost: string; swiftCost: string } {
  const map: Record<string, { provider: string; totalCost: string; swiftCost: string }> = {
    'USD:KES': { provider: 'Western Union', totalCost: '3–5% + $5 fixed fee',      swiftCost: '$25–40' },
    'USD:NGN': { provider: 'Remitly',       totalCost: '3.5% + correspondent fee', swiftCost: '$15–30' },
    'USD:GHS': { provider: 'WorldRemit',    totalCost: '3% + $3.99 fixed',         swiftCost: '$25' },
    'GBP:KES': { provider: 'WorldRemit',    totalCost: '2.9% + SWIFT fee',         swiftCost: '$15–25' },
    'EUR:KES': { provider: 'Wise',          totalCost: '3.1% all-in',              swiftCost: '$20' },
  };
  return map[`${from}:${to}`] ?? { provider: 'Traditional bank', totalCost: '3–5% + SWIFT', swiftCost: '$25–50' };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type QuoteStatus = 'ACTIVE' | 'EXECUTED' | 'EXPIRED';

export interface Quote {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
  toAmount: number;
  rate: number;              // locked rate shown to user
  midRate: number;           // raw B2BinPay mid-market rate
  platformFee: number;       // fee in fromCurrency
  feePct: number;            // corridor fee %
  usdAmount: number;
  usdtAmount: number;
  expiresAt: number;
  expiresInSeconds: number;
  status: QuoteStatus;
  createdAt: number;
  margin: {
    revenueUsd: number;       // what FinCruse earns (USD)
    costUsd: number;          // B2BinPay spread + Solana gas
    profitUsd: number;        // revenue - cost
    swiftSaved: number;       // SWIFT fee we didn't pay
    traditionalProvider: string;
    traditionalFee: string;
  };
}

// ── In-memory store (swap for Redis in production) ────────────────────────────

const quotes = new Map<string, Quote>();

// Clean up expired quotes every 60s
setInterval(() => {
  const now = Date.now();
  for (const [id, q] of quotes) {
    if (now > q.expiresAt + 60_000) quotes.delete(id);
  }
}, 60_000);

// ── Rate cache (avoid hammering B2BinPay on every quote) ─────────────────────

interface RateCacheEntry { mid: number; fetchedAt: number }
const rateCache = new Map<string, RateCacheEntry>();

async function fetchMidRate(from: string, to: string): Promise<number> {
  const fromN = from.toUpperCase();
  const toN = to.toUpperCase();

  if (fromN === toN) return 1;
  if ((fromN === 'USD' || fromN === 'USDT') && (toN === 'USD' || toN === 'USDT')) return 1;

  const key = `${fromN}:${toN}`;
  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < RATE_CACHE_MS) return cached.mid;

  // B2BinPay quotes left currency in right currency terms
  // e.g. left=GBP → rate is "how much USDT per 1 GBP"
  const left = (fromN === 'USD' || fromN === 'USDT') ? toN : fromN;
  const res = await getRates([left]) as {
    data?: { attributes?: { left: string; right: string; bid: string; ask: string } }[]
  };

  let mid = 1;
  for (const item of res.data ?? []) {
    const a = item.attributes;
    if (!a) continue;
    const m = (parseFloat(a.bid) + parseFloat(a.ask)) / 2;
    const k1 = `${a.left.toUpperCase()}:${a.right.toUpperCase()}`;
    const k2 = `${a.right.toUpperCase()}:${a.left.toUpperCase()}`;
    const now = Date.now();
    rateCache.set(k1, { mid: m, fetchedAt: now });
    rateCache.set(k2, { mid: 1 / m, fetchedAt: now });
    if (k1 === key) mid = m;
    if (k2 === key) mid = 1 / m;
  }

  return mid;
}

// ── Core: create a JIT quote ──────────────────────────────────────────────────

export async function createQuote(params: {
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
}): Promise<Quote> {
  const { fromCurrency, toCurrency, fromAmount } = params;

  if (fromAmount <= 0) throw new Error('fromAmount must be greater than 0');

  const fromN = fromCurrency.toUpperCase();
  const toN   = toCurrency.toUpperCase();

  // 1. Get B2BinPay institutional mid-market rate
  const institutionalRate = await fetchMidRate(fromN, toN);

  // 2. FinCruse spread markup — built into the rate, NO visible fee to user
  const spreadPct   = getSpreadMarkup(fromN, toN);
  const traditional = getTraditionalComparison(fromN, toN);

  // 3. Customer rate = institutional rate × (1 - spread)
  //    User sends full amount — no deduction — they just get a slightly off-market rate
  const customerRate = institutionalRate * (1 - spreadPct);

  // 4. What receiver gets at customer rate (no fee deducted from sender amount)
  const feeAmount      = 0;         // NO explicit fee charged
  const amountAfterFee = fromAmount; // full amount converted

  // 5. Receiver gets full amount at customer rate (no fee deducted)
  const toAmount   = parseFloat((fromAmount * customerRate).toFixed(8));
  const lockedRate = customerRate;

  // 6. What receiver WOULD get at institutional rate (difference = FinCruse revenue)
  const toAmountAtMid = parseFloat((fromAmount * institutionalRate).toFixed(8));

  // 7. USD base + USDT for Fireblocks
  const usdAmount  = await toUSD(fromAmount, fromN);
  const usdtAmount = usdToUsdt(usdAmount);

  // 8. Margin: FinCruse earns the spread difference, pays B2BinPay per-tx fee
  const spreadRevenue = parseFloat((toAmountAtMid - toAmount).toFixed(4)); // in toCurrency
  const spreadRevenueUsd = parseFloat((usdAmount * spreadPct).toFixed(4)); // in USD
  const b2bCost    = parseFloat((usdAmount * B2B_INSTITUTIONAL_PCT + SOLANA_GAS_USD).toFixed(4));
  const profitUsd  = parseFloat((spreadRevenueUsd - b2bCost).toFixed(4));
  const swiftSaved = 25;

  const now = Date.now();
  const quote: Quote = {
    id: randomUUID(),
    fromCurrency: fromN,
    toCurrency: toN,
    fromAmount,
    toAmount,
    rate: lockedRate,
    midRate: institutionalRate,
    platformFee: 0,           // NO fee charged to user
    feePct: 0,
    usdAmount,
    usdtAmount,
    expiresAt: now + QUOTE_TTL_MS,
    expiresInSeconds: QUOTE_TTL_MS / 1000,
    status: 'ACTIVE',
    createdAt: now,
    margin: {
      revenueUsd:          spreadRevenueUsd,
      costUsd:             b2bCost,
      profitUsd,
      swiftSaved,
      traditionalProvider: traditional.provider,
      traditionalFee:      traditional.totalCost,
    },
  };

  quotes.set(quote.id, quote);
  return quote;
}

// ── Get quote (with live expiry countdown) ────────────────────────────────────

export function getQuote(quoteId: string): Quote {
  const quote = quotes.get(quoteId);
  if (!quote) throw new Error(`Quote ${quoteId} not found`);

  const now = Date.now();
  if (quote.status === 'ACTIVE' && now > quote.expiresAt) {
    quote.status = 'EXPIRED';
    quotes.set(quoteId, quote);
  }

  return {
    ...quote,
    expiresInSeconds: Math.max(0, Math.floor((quote.expiresAt - now) / 1000)),
  };
}

// ── Validate + lock quote for execution (atomic single-use) ───────────────────

export function consumeQuote(quoteId: string): Quote {
  const quote = getQuote(quoteId);

  if (quote.status === 'EXPIRED') {
    throw new Error(`Quote ${quoteId} has expired. Request a new quote.`);
  }
  if (quote.status === 'EXECUTED') {
    throw new Error(`Quote ${quoteId} has already been used.`);
  }

  // Mark as executed immediately — prevents double-spend
  quote.status = 'EXECUTED';
  quotes.set(quoteId, quote);

  return quote;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatQuoteResponse(q: Quote) {
  const now = Date.now();
  return {
    quoteId:     q.id,
    status:      q.status,
    from:        { currency: q.fromCurrency, amount: q.fromAmount },
    to:          { currency: q.toCurrency,   amount: q.toAmount },
    rate:        q.rate,
    fee:         'No fee — rate includes our margin',   // transparent to user
    revenueModel: {
      type:                'FX spread — built into the rate',
      institutionalRate:   q.midRate,   // what B2BinPay gives FinCruse
      customerRate:        q.rate,       // what user sees
      b2bInstitutionalFee: 'Per transaction at institutional grade (B2BinPay)',
      fincruseRevenue:     `$${q.margin.revenueUsd} USD (spread)`,
      b2bCost:             `$${q.margin.costUsd} USD (B2BinPay per-tx fee)`,
      profitPerTx:         `$${q.margin.profitUsd} USD`,
      swiftNotPaid:        `$${q.margin.swiftSaved} (not used)`,
      solanGas:            `$${SOLANA_GAS_USD}`,
      vsTraditional:       `${q.margin.traditionalProvider}: ${q.margin.traditionalFee} — we skip SWIFT entirely`,
    },
    expiresIn:   Math.max(0, Math.floor((q.expiresAt - now) / 1000)),
    expiresAt:   new Date(q.expiresAt).toISOString(),
    jit:         true,
  };
}
