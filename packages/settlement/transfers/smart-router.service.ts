/**
 * AxLink Smart Router
 *
 * Every quote request is classified into one of four route types before any
 * LP is contacted. The route type controls spread, rate-floor protection, and
 * how the execution path is selected.
 *
 * Route Types
 * ─────────────────────────────────────────────────────────────────────────────
 * IDENTITY   — same currency (KES→KES, GBP→GBP)
 *              spread = 0%, rate = 1, no LP needed, pure vault-to-vault
 *
 * STABLE     — economic equivalents: USD↔USDT↔USDT_SOL↔USDT_TRX↔USDT_ERC20
 *              spread = 0%, rate = 1, no LP needed
 *              (user converting USD to hold USDT in Fireblocks or vice versa
 *               must not be taxed — they're the same asset internally)
 *
 * MAJOR      — liquid FX pairs with deep markets: GBP/USD, EUR/USD, USD/CAD …
 *              spread = 0.5–0.8%, tight because LP execution risk is low
 *
 * CORRIDOR   — Africa + EM cross-border: GBP/KES, USD/NGN, EUR/GHS …
 *              spread = 1.5–2.2%, wider because LP liquidity is thinner
 *
 * Rate Floor Protection
 * ─────────────────────────────────────────────────────────────────────────────
 * After the LP returns its rate, the smart router validates that the customer
 * rate (LP rate minus AxLink spread) does not fall below a floor relative to
 * the theoretical mid-market rate. If the LP is offering a bad rate (e.g.,
 * during a liquidity crunch or a mis-quote), the trade is blocked and the user
 * gets a clear error instead of silently losing money.
 *
 * Floor = midMarketRate × (1 − MAX_LOSS_PCT)
 *
 * Example: GBP→KES mid = 163.80
 *   spread 1.8% → customerRate = 163.80 × 0.982 = 160.85
 *   floor at 5% → floor = 163.80 × 0.95 = 155.61
 *   160.85 > 155.61 → PASS
 *   If LP only offered 150 → customerRate = 150 × 0.982 = 147.30 < 155.61 → BLOCKED
 */

// ── Route types ───────────────────────────────────────────────────────────────

export type RouteType = 'IDENTITY' | 'STABLE' | 'MAJOR' | 'CORRIDOR';

// Currencies that are economically equivalent to USD — no FX, no spread
const STABLE_USD_SET = new Set(['USD', 'USDT', 'USDT_SOL', 'USDT_TRX', 'USDT_ERC20']);

function normalise(c: string): string {
  return c.toUpperCase();
}

function isStable(c: string): boolean {
  return STABLE_USD_SET.has(normalise(c));
}

// Major FX pairs — liquid, tight spread
const MAJOR_PAIRS = new Set([
  'GBP:USD', 'USD:GBP',
  'EUR:USD', 'USD:EUR',
  'GBP:EUR', 'EUR:GBP',
  'USD:CAD', 'CAD:USD',
  'EUR:CAD', 'CAD:EUR',
  'GBP:CAD', 'CAD:GBP',
]);

export function classifyRoute(from: string, to: string): RouteType {
  const fromN = normalise(from);
  const toN   = normalise(to);

  if (fromN === toN)                    return 'IDENTITY';
  if (isStable(fromN) && isStable(toN)) return 'STABLE';
  if (MAJOR_PAIRS.has(`${fromN}:${toN}`)) return 'MAJOR';
  return 'CORRIDOR';
}

// ── Spread table by route type and corridor ───────────────────────────────────
// Returns the fraction to SUBTRACT from the LP's institutional rate.
// customerRate = lpRate × (1 − spread)

const CORRIDOR_SPREADS: Record<string, number> = {
  // Africa → developed market
  'GBP:KES': 0.018, 'USD:KES': 0.018, 'EUR:KES': 0.018,
  'GBP:NGN': 0.022, 'USD:NGN': 0.022, 'EUR:NGN': 0.022,
  'GBP:GHS': 0.020, 'USD:GHS': 0.020,
  'GBP:ZAR': 0.018, 'USD:ZAR': 0.015,
  'GBP:UGX': 0.020, 'USD:UGX': 0.020,
  'GBP:TZS': 0.020, 'USD:TZS': 0.020,
  // Africa intra-corridor
  'KES:NGN': 0.022, 'NGN:KES': 0.022,
  'KES:GHS': 0.022, 'GHS:KES': 0.022,
  'KES:ZAR': 0.020, 'ZAR:KES': 0.020,
  // Reverse: developed → Africa
  'KES:GBP': 0.018, 'KES:USD': 0.018, 'KES:EUR': 0.018,
  'NGN:GBP': 0.022, 'NGN:USD': 0.022,
  'GHS:GBP': 0.020, 'GHS:USD': 0.020,
  'ZAR:GBP': 0.018, 'ZAR:USD': 0.015,
};

const MAJOR_SPREADS: Record<string, number> = {
  'GBP:USD': 0.005, 'USD:GBP': 0.005,
  'EUR:USD': 0.005, 'USD:EUR': 0.005,
  'GBP:EUR': 0.006, 'EUR:GBP': 0.006,
  'USD:CAD': 0.006, 'CAD:USD': 0.006,
  'EUR:CAD': 0.008, 'GBP:CAD': 0.008,
};

const DEFAULT_CORRIDOR_SPREAD = 0.020; // fallback for any unrecognised corridor

export function getSpread(from: string, to: string): number {
  const route = classifyRoute(from, to);
  const key   = `${normalise(from)}:${normalise(to)}`;

  switch (route) {
    case 'IDENTITY': return 0;
    case 'STABLE':   return 0;
    case 'MAJOR':    return MAJOR_SPREADS[key] ?? 0.008;
    case 'CORRIDOR': return CORRIDOR_SPREADS[key] ?? DEFAULT_CORRIDOR_SPREAD;
  }
}

// ── Rate floor protection ─────────────────────────────────────────────────────
// Maximum acceptable FX loss relative to the theoretical mid-market rate.
// Prevents bad LP quotes from silently robbing users.

const RATE_FLOOR: Record<RouteType, number> = {
  IDENTITY: 0,      // exact 1:1 required
  STABLE:   0,      // exact 1:1 required
  MAJOR:    0.015,  // customer rate may not be more than 1.5% below mid
  CORRIDOR: 0.050,  // customer rate may not be more than 5% below mid
};

export interface RateFloorResult {
  passed: boolean;
  customerRate: number;
  midRate: number;
  floorRate: number;
  lossFromMid: number; // fraction
  route: RouteType;
}

export function checkRateFloor(
  lpRate: number,
  midRate: number,
  from: string,
  to: string,
): RateFloorResult {
  const route       = classifyRoute(from, to);
  const spread      = getSpread(from, to);
  const customerRate = lpRate * (1 - spread);
  const maxLoss     = RATE_FLOOR[route];
  const floorRate   = midRate * (1 - maxLoss);
  const lossFromMid = midRate > 0 ? (midRate - customerRate) / midRate : 0;

  return {
    passed:       customerRate >= floorRate,
    customerRate,
    midRate,
    floorRate,
    lossFromMid,
    route,
  };
}

// ── Human-readable route description ─────────────────────────────────────────

export function describeRoute(from: string, to: string): string {
  const route = classifyRoute(from, to);
  const spread = getSpread(from, to);
  switch (route) {
    case 'IDENTITY': return `${from}→${to}: same currency — no FX, vault-to-vault`;
    case 'STABLE':   return `${from}→${to}: stable pair — no FX, 1:1 conversion`;
    case 'MAJOR':    return `${from}→${to}: major pair — ${(spread * 100).toFixed(2)}% spread`;
    case 'CORRIDOR': return `${from}→${to}: corridor — ${(spread * 100).toFixed(2)}% spread`;
  }
}
