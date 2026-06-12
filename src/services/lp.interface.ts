// ── AxLink Liquidity Provider Interface ──────────────────────────────────────
// Any external LP implements this interface and plugs into the LP Registry.
// The Registry broadcasts RFQs to all capable LPs simultaneously (JIT RFQ).
// The LP with the best rate wins — zero code change to the core settlement flow.
//
// Built-in LPs: AxLink Internal (fallback), B2BinPay
// Plug-in: Kraken, Binance, Coinbase, any institutional LP → just implement + register

export interface LPRate {
  bid: number;
  ask: number;
  mid: number;
  spread: number;      // ask - bid, absolute
  spreadPct: number;   // spread as % of mid
  fetchedAt: number;   // unix ms — callers check staleness
  source: string;      // LP id for audit trail
}

// Binding JIT quote — LP commits to this rate until validUntil
// If LP has a quoteId, include it so execution can reference it
export interface LPQuote {
  id: string;           // AxLink-generated or LP-provided quote ref
  from: string;
  to: string;
  fromAmount: number;
  toAmount: number;     // amount of `to` LP will deliver at this rate
  rate: number;         // toAmount / fromAmount
  validUntil: number;   // Unix ms — RFQ binding window
  source: string;       // LP id (for audit + execution routing)
  raw?: unknown;        // LP-specific response payload (stored for audit)
}

export interface ILiquidityProvider {
  readonly id: string;
  readonly name: string;

  // Returns true if this LP can quote this pair (either direction)
  supportsRate(fromCurrency: string, toCurrency: string): boolean;

  // Indicative (non-binding) mid-market rate — fast, used for pre-flight checks
  getRate(fromCurrency: string, toCurrency: string): Promise<LPRate>;

  // Binding JIT RFQ — LP commits to deliver toAmount for fromAmount
  // until quote.validUntil. Use quote.id on execution.
  requestQuote(from: string, to: string, fromAmount: number): Promise<LPQuote>;
}
