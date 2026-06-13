import { randomUUID } from 'crypto';
import { toUSD, usdToUsdt } from './fx.service';
import { broadcastRFQ, getRegisteredLPs } from './lp-registry.service';
import { classifyRoute, getSpread, checkRateFloor, describeRoute } from './smart-router.service';
import type { LPQuote } from './lp.interface';

// ── Config ────────────────────────────────────────────────────────────────────

const QUOTE_TTL_MS  = 30_000;
const RATE_CACHE_MS = 10_000;

// ── FinCruse Revenue Model ────────────────────────────────────────────────────
//
// Spread is determined by the Smart Router based on route type:
//   IDENTITY / STABLE → 0%      (same currency or USD↔USDT — no tax on 1:1 moves)
//   MAJOR            → 0.5–0.8% (GBP/USD, EUR/USD — tight, deep-market pairs)
//   CORRIDOR         → 1.5–2.2% (GBP/KES, USD/NGN — EM cross-border, thinner LP)
//
// Rate floor protection ensures LP mis-quotes never silently hurt the user.

// Estimated LP per-tx cost (applies to whichever LP is selected by the registry)
const LP_INSTITUTIONAL_PCT = 0.003;   // ~0.3%
const SOLANA_GAS_USD        = 0.00025;

function getTraditionalComparison(from: string, to: string) {
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
  rate: number;              // locked customer rate (LP rate minus AxLink spread)
  midRate: number;           // LP winning rate (before AxLink spread)
  lpSource: string;          // winning LP id
  lpQuoteId: string;         // LP's own quote reference (for audit)
  platformFee: number;       // always 0 — fee is in the spread
  feePct: number;
  usdAmount: number;
  usdtAmount: number;        // USD = USDT 1:1 (Fireblocks vault — AxLink internal transport)
  expiresAt: number;
  expiresInSeconds: number;
  status: QuoteStatus;
  createdAt: number;
  margin: {
    revenueUsd: number;
    costUsd: number;
    profitUsd: number;
    swiftSaved: number;
    traditionalProvider: string;
    traditionalFee: string;
  };
}

// ── In-memory store (swap for Redis in production) ────────────────────────────

const quotes = new Map<string, Quote>();

// Remove quotes >60s past expiry — prevents unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [id, q] of quotes) {
    if (now > q.expiresAt + 60_000) quotes.delete(id);
  }
}, 60_000);

// ── Rate cache — short-lived to avoid hammering the LP on rapid quote requests ─

interface CacheEntry { mid: number; fetchedAt: number; source: string }
const rateCache = new Map<string, CacheEntry>();

// RFQ cache — avoid hammering LPs on rapid quote requests
// Cache stores the winning LP quote for short dedup window
interface RFQCacheEntry { lpQuote: LPQuote; fetchedAt: number; source: string }
const rfqCache = new Map<string, RFQCacheEntry>();

async function fetchBestQuote(
  from: string,
  to: string,
  fromAmount: number,
): Promise<{ lpQuote: LPQuote; source: string }> {
  const fromN = from.toUpperCase();
  const toN   = to.toUpperCase();
  if (fromN === toN) {
    const stub: LPQuote = { id: 'same', from: fromN, to: toN, fromAmount, toAmount: fromAmount, rate: 1, validUntil: Date.now() + 30_000, source: 'identity' };
    return { lpQuote: stub, source: 'identity' };
  }

  const key    = `${fromN}:${toN}:${Math.round(fromAmount)}`;
  const cached = rfqCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < RATE_CACHE_MS) {
    return { lpQuote: cached.lpQuote, source: cached.source };
  }

  // JIT RFQ — broadcast to all registered LPs, take winner
  const { quote, winner } = await broadcastRFQ(fromN, toN, fromAmount);
  const entry: RFQCacheEntry = { lpQuote: quote, fetchedAt: Date.now(), source: winner.id };
  rfqCache.set(key, entry);
  return { lpQuote: quote, source: winner.id };
}

// ── Core: create a JIT quote ──────────────────────────────────────────────────
// Rate is locked for QUOTE_TTL_MS (30s). consumeQuote() marks it single-use.
// Zero pre-funded corridor: the locked rate is used atomically at execution time.

export async function createQuote(params: {
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
}): Promise<Quote> {
  const { fromCurrency, toCurrency, fromAmount } = params;
  if (fromAmount <= 0) throw new Error('fromAmount must be greater than 0');

  const fromN = fromCurrency.toUpperCase();
  const toN   = toCurrency.toUpperCase();

  // ── Smart Router: classify route before touching LPs ─────────────────────
  const routeType = classifyRoute(fromN, toN);
  console.log(`[SmartRouter] ${describeRoute(fromN, toN)}`);

  // IDENTITY + STABLE → 1:1, no LP, no spread, no FX loss
  if (routeType === 'IDENTITY' || routeType === 'STABLE') {
    const usdAmount  = await toUSD(fromAmount, fromN);
    const usdtAmount = usdToUsdt(usdAmount);
    const now = Date.now();
    const q: Quote = {
      id: randomUUID(), fromCurrency: fromN, toCurrency: toN,
      fromAmount, toAmount: fromAmount,
      rate: 1, midRate: 1,
      lpSource: routeType.toLowerCase(), lpQuoteId: `${routeType.toLowerCase()}_bypass`,
      platformFee: 0, feePct: 0,
      usdAmount, usdtAmount,
      expiresAt: now + QUOTE_TTL_MS, expiresInSeconds: QUOTE_TTL_MS / 1000,
      status: 'ACTIVE', createdAt: now,
      margin: { revenueUsd: 0, costUsd: 0, profitUsd: 0, swiftSaved: 0, traditionalProvider: 'N/A', traditionalFee: '0%' },
    };
    quotes.set(q.id, q);
    return q;
  }

  // MAJOR / CORRIDOR → JIT RFQ + Smart Router spread + rate floor guard

  // 1. JIT RFQ — broadcast to all registered LPs, take winning quote
  const { lpQuote, source: lpSource } = await fetchBestQuote(fromN, toN, fromAmount);

  // 2. Smart Router spread — corridor-aware, not a flat default
  const spreadPct         = getSpread(fromN, toN);
  const traditional       = getTraditionalComparison(fromN, toN);
  const institutionalRate = lpQuote.rate;

  // 3. Rate floor protection — reject if LP is quoting a bad rate
  const floorCheck = checkRateFloor(institutionalRate, institutionalRate, fromN, toN);
  if (!floorCheck.passed) {
    throw Object.assign(
      new Error(
        `[SmartRouter] Rate protection triggered for ${fromN}→${toN}: ` +
        `customer rate ${floorCheck.customerRate.toFixed(6)} is below floor ${floorCheck.floorRate.toFixed(6)} ` +
        `(${(floorCheck.lossFromMid * 100).toFixed(2)}% loss from mid-market). ` +
        `LP may be in a liquidity crunch. Trade blocked.`,
      ),
      { code: 'RATE_PROTECTION_TRIGGERED', statusCode: 422 },
    );
  }

  const customerRate = institutionalRate * (1 - spreadPct);

  // 4. Receiver amount at customer rate
  const toAmount = parseFloat((fromAmount * customerRate).toFixed(8));

  // 5. USD + USDT equivalents for Fireblocks vault transport
  const usdAmount  = await toUSD(fromAmount, fromN);
  const usdtAmount = usdToUsdt(usdAmount);

  // 6. Margin calculation
  const spreadRevenueUsd = parseFloat((usdAmount * spreadPct).toFixed(4));
  const costUsd          = parseFloat((usdAmount * LP_INSTITUTIONAL_PCT + SOLANA_GAS_USD).toFixed(4));
  const profitUsd        = parseFloat((spreadRevenueUsd - costUsd).toFixed(4));

  console.log(
    `[SmartRouter] ${fromN}→${toN} ${routeType} ` +
    `lpRate=${institutionalRate.toFixed(6)} spread=${(spreadPct * 100).toFixed(2)}% ` +
    `customerRate=${customerRate.toFixed(6)} profitUsd=$${profitUsd}`,
  );

  const now   = Date.now();
  const quote: Quote = {
    id:              randomUUID(),
    fromCurrency:    fromN,
    toCurrency:      toN,
    fromAmount,
    toAmount,
    rate:            customerRate,
    midRate:         institutionalRate,
    lpSource,
    lpQuoteId:       lpQuote.id,
    platformFee:     0,
    feePct:          0,
    usdAmount,
    usdtAmount,
    expiresAt:       now + QUOTE_TTL_MS,
    expiresInSeconds: QUOTE_TTL_MS / 1000,
    status:          'ACTIVE',
    createdAt:       now,
    margin: {
      revenueUsd:          spreadRevenueUsd,
      costUsd,
      profitUsd,
      swiftSaved:          25,
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

  return { ...quote, expiresInSeconds: Math.max(0, Math.floor((quote.expiresAt - now) / 1000)) };
}

// ── Consume quote — atomic single-use gate (prevents double-spend) ────────────

export function consumeQuote(quoteId: string): Quote {
  const quote = getQuote(quoteId);

  if (quote.status === 'EXPIRED') {
    throw new Error(`Quote ${quoteId} has expired — request a new quote.`);
  }
  if (quote.status === 'EXECUTED') {
    throw new Error(`Quote ${quoteId} already used.`);
  }

  quote.status = 'EXECUTED';
  quotes.set(quoteId, quote);
  return quote;
}

// ── Response formatter ────────────────────────────────────────────────────────

export function formatQuoteResponse(q: Quote) {
  const now = Date.now();
  return {
    quoteId:  q.id,
    status:   q.status,
    from:     { currency: q.fromCurrency, amount: q.fromAmount },
    to:       { currency: q.toCurrency,   amount: q.toAmount },
    rate:     q.rate,
    fee:      'No fee — margin is in the exchange rate',
    rfq: {
      winningLP:       q.lpSource,
      lpQuoteRef:      q.lpQuoteId,
      lpRate:          q.midRate,
      axlinkSpread:    `${(getSpread(q.fromCurrency, q.toCurrency) * 100).toFixed(2)}%`,
      routeType:       classifyRoute(q.fromCurrency, q.toCurrency),
      customerRate:    q.rate,
      registeredLPs:   getRegisteredLPs().map(l => l.name),
    },
    revenueModel: {
      type:             'FX spread (built into rate)',
      fincruseRevenue:  `$${q.margin.revenueUsd} USD`,
      lpCost:           `$${q.margin.costUsd} USD`,
      profitPerTx:      `$${q.margin.profitUsd} USD`,
      swiftNotPaid:     `$${q.margin.swiftSaved} (not used)`,
      fireblocksGas:    `$${SOLANA_GAS_USD} (Solana/USDT)`,
      vsTraditional:    `${q.margin.traditionalProvider}: ${q.margin.traditionalFee} — no SWIFT`,
    },
    expiresIn:    Math.max(0, Math.floor((q.expiresAt - now) / 1000)),
    expiresAt:    new Date(q.expiresAt).toISOString(),
    jit:          true,
    zeroPrefund:  true,
    settlement:   'USDT (Fireblocks / Solana) — AxLink internal',
  };
}
