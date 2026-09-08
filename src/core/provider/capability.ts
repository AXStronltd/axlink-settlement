/**
 * Provider capability model + funding plan resolver.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS
 *
 *  `IBaaSProvider.atomicJit` is a boolean, which can only express two
 *  shapes:
 *
 *    atomicJit = true   → hand the provider USDT, it does everything
 *    atomicJit = false  → hand the provider the exact payout currency
 *
 *  Real payout partners have a third shape, and it is the common one in
 *  Africa and Asia:
 *
 *    "Fund me in USD. I will apply my own FX and deliver KES."
 *
 *  B2BinPay settles USD/EUR/GBP only. So under the boolean model every
 *  local-currency corridor — KES via Daraja, NGN/GHS/ZAR via Choice Bank —
 *  is unreachable: we cannot fund the partner in KES, and the model has no
 *  way to say "fund in USD, deliver KES".
 *
 *  A capability declares the two currency sets separately:
 *
 *    settlementCurrencies — what the partner accepts as funding
 *    payoutCurrencies     — what the partner can deliver
 *
 *  and `resolveFundingPlan` picks the settlement currency, computes the
 *  amount to send, and records who bears the FX. Nothing in the core has to
 *  know which partner it is talking to.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Providers that predate this model do not have to change: `deriveCapability`
 * infers an equivalent descriptor from `atomicJit` + `supportedCurrencies`.
 */

import type { IBaaSProvider, PayoutMethod } from '../baas.interface';

/** The settlement currency used when a partner takes crypto directly. */
export const USDT = 'USDT';

// ── Capability descriptor ─────────────────────────────────────────────────────

export interface AmountBand {
  /** Inclusive minimum, in the payout currency. */
  min?: number;
  /** Inclusive maximum, in the payout currency. */
  max?: number;
}

export interface ProviderCapability {
  /**
   * Currencies this partner accepts as funding, in preference order.
   *
   * Use 'USDT' if the partner takes crypto and handles conversion itself
   * (this is what `atomicJit: true` used to mean). Otherwise list the fiat
   * currencies the partner can be credited in — commonly ['USD'] for an
   * African payout partner that applies its own FX.
   */
  settlementCurrencies: string[];

  /** Currencies this partner can deliver to a beneficiary. */
  payoutCurrencies: string[];

  /** Delivery rails this partner supports. */
  methods: PayoutMethod[];

  /** ISO 3166-1 alpha-2 codes. Empty/omitted means "no country restriction". */
  countries?: string[];

  /** Per-payout-currency amount limits, keyed by ISO code. */
  limits?: Record<string, AmountBand>;

  /**
   * True when the partner applies its own FX between the settlement currency
   * and the payout currency. The rate we quote the customer is then an
   * estimate until the partner confirms — `FundingPlan.fxBearer` carries this
   * through to the caller so it can be surfaced and journalled.
   */
  partnerAppliesFx?: boolean;

  /**
   * Whether this partner is licensed to receive and hold crypto.
   *
   * Defaults to FALSE, and the default is the safe one: most payout partners
   * are money-transmission licensed but hold no VASP registration, so sending
   * them USDT would push a regulated obligation onto a counterparty that
   * cannot legally accept it. `resolveFundingPlan` refuses to build a USDT
   * plan unless this is explicitly true — a compliance guardrail, not a
   * tuning knob.
   */
  cryptoLicensed?: boolean;

  /**
   * Whether we hold a pre-funded float with this partner.
   *
   * This is the only way an unlicensed partner can pay a beneficiary in real
   * time: they disburse from float they already hold, and our fiat wire
   * *replenishes* them afterwards rather than gating the payout.
   *
   * The trade is working capital — a float is capital parked in a corridor,
   * which is exactly what the JIT model exists to avoid. Set per partner, and
   * size it deliberately: the float is the maximum you can lose to a partner
   * failure.
   */
  prefundedFloat?: boolean;
}

// ── Compatibility shim ────────────────────────────────────────────────────────

/**
 * A provider may declare `capability` directly. If it does not, derive one
 * from the legacy fields so existing providers keep working unchanged.
 */
export function deriveCapability(provider: IBaaSProvider): ProviderCapability {
  const declared = (provider as IBaaSProvider & { capability?: ProviderCapability }).capability;
  if (declared) return declared;

  const payoutCurrencies = provider.supportedCurrencies.map(c => c.toUpperCase());

  return {
    // atomicJit true  → partner takes USDT and does everything
    // atomicJit false → legacy assumption: partner is funded in the payout
    //                   currency itself. This is what breaks KES/NGN, and is
    //                   exactly what a provider should override by declaring
    //                   `capability` with settlementCurrencies: ['USD'].
    settlementCurrencies: provider.atomicJit ? [USDT] : payoutCurrencies,
    payoutCurrencies,
    // Unknown from the legacy fields — canHandle() remains the authority on
    // method support, so leave this permissive rather than wrongly narrow.
    methods: ['mobile_money', 'bank_transfer', 'card', 'cash', 'wallet'],
    partnerAppliesFx: false,
    // Deliberately NOT inferred from `atomicJit`.
    //
    // The old boolean asserted a technical capability ("takes USDT"); crypto
    // licensing is a legal fact about the counterparty and cannot be inferred
    // from code. Leaving this undefined means a legacy `atomicJit: true`
    // provider now fails closed at `resolveFundingPlan` with an explicit
    // message, instead of quietly continuing to receive crypto. Whoever owns
    // that partner relationship has to confirm the licence and declare it.
    cryptoLicensed: undefined,
    prefundedFloat: false,
  };
}

// ── Funding plan ──────────────────────────────────────────────────────────────

export type FundingMode =
  /**
   * Partner is credited in USDT and does conversion + delivery itself.
   * Requires `cryptoLicensed: true`.
   */
  | 'ATOMIC_USDT'
  /**
   * Partner disburses immediately from a float we already hold with them; our
   * fiat wire replenishes that float afterwards and is NOT on the critical
   * path of the payout. The only real-time option for an unlicensed partner.
   */
  | 'PREFUNDED_FLOAT'
  /** Partner is credited in the payout currency itself. No FX at the partner. */
  | 'DIRECT_FIAT'
  /** Partner is credited in a bridge currency (usually USD) and applies its own FX. */
  | 'PARTNER_FX';

export type FxBearer = 'NONE' | 'AXLINK' | 'PARTNER';

export interface FundingPlan {
  mode: FundingMode;
  providerId: string;

  /** What the beneficiary receives. */
  payoutCurrency: string;
  payoutAmount: number;

  /** What we send the partner. 'USDT' for ATOMIC_USDT. */
  settlementCurrency: string;
  settlementAmount: number;

  /**
   * settlementCurrency → payoutCurrency rate used to size the funding.
   * Null when no conversion is involved (DIRECT_FIAT, ATOMIC_USDT).
   * Indicative only when fxBearer is 'PARTNER'.
   */
  fxRate: number | null;
  fxBearer: FxBearer;

  /** True when B2BinPay has to convert USDT → settlementCurrency first. */
  requiresB2bConversion: boolean;

  /**
   * True when the beneficiary is paid before our funding leg lands — i.e. the
   * partner disburses from float. The funding leg is then replenishment, and
   * must not gate the payout's status.
   *
   * When false, the beneficiary cannot be paid until the funding leg settles,
   * and any "instant" claim in the product is about our internal transport,
   * not about when the recipient gets money.
   */
  payoutPrecedesFunding: boolean;

  /** Human-readable reason this plan was chosen. Recorded on the attempt log. */
  rationale: string;
}

export interface FundingContext {
  /** Currencies the USDT→fiat converter (B2BinPay) can actually settle. */
  converterSettlementCurrencies: Set<string>;
  /** settlementCurrency → payoutCurrency conversion. Injected so this stays testable. */
  getRate: (from: string, to: string) => Promise<number>;
  /** Preferred bridge currencies, in order, when partner-side FX is required. */
  bridgePreference?: string[];
}

const DEFAULT_BRIDGE_PREFERENCE = ['USD', 'EUR', 'GBP'];

/**
 * Decide how to fund a partner for a given payout.
 *
 * Preference order, cheapest-and-least-surprising first:
 *
 *   1. ATOMIC_USDT  — partner takes crypto. One hop, no fiat conversion,
 *                     no FX ambiguity. Always preferred when available.
 *   2. DIRECT_FIAT  — partner takes the payout currency and our converter can
 *                     produce it. No FX at the partner, rate is ours and known.
 *   3. PARTNER_FX   — partner takes a bridge currency (USD/EUR/GBP) and applies
 *                     its own FX. Unblocks every local-currency corridor.
 *
 * Throws with an actionable message when no plan exists, rather than letting a
 * doomed payout request reach the converter with USDT already in flight.
 */
export async function resolveFundingPlan(params: {
  providerId: string;
  capability: ProviderCapability;
  payoutCurrency: string;
  payoutAmount: number;
  usdtAmount: number;
  context: FundingContext;
}): Promise<FundingPlan> {
  const { providerId, capability, payoutAmount, usdtAmount, context } = params;
  const payoutCurrency = params.payoutCurrency.toUpperCase();

  const settles = capability.settlementCurrencies.map(c => c.toUpperCase());
  const base = {
    providerId,
    payoutCurrency,
    payoutAmount,
  };

  // 0 — compliance guard, before any routing.
  //
  // A partner that is not licensed to hold crypto must never be sent USDT,
  // regardless of what its capability lists. Refuse loudly rather than
  // silently downgrading: a capability that declares USDT on an unlicensed
  // partner is a misconfiguration someone needs to fix, not a preference to
  // route around.
  if (settles.includes(USDT) && capability.cryptoLicensed !== true) {
    throw fundingError(
      `Provider '${providerId}' declares USDT settlement but is not marked ` +
      `cryptoLicensed. Sending crypto to a partner without a VASP registration ` +
      `pushes a regulated obligation onto a counterparty that cannot accept it. ` +
      `Either set capability.cryptoLicensed = true (only with the partner's ` +
      `licence on file) or remove USDT from settlementCurrencies.`,
    );
  }

  // 1 — partner takes USDT directly. Licensed partners only.
  if (settles.includes(USDT)) {
    return {
      ...base,
      mode: 'ATOMIC_USDT',
      settlementCurrency: USDT,
      settlementAmount: usdtAmount,
      fxRate: null,
      fxBearer: 'NONE',
      requiresB2bConversion: false,
      payoutPrecedesFunding: false,
      rationale: `${providerId} is crypto-licensed and settles in USDT — conversion and delivery are atomic at the partner`,
    };
  }

  // 2 — pre-funded float. The partner already holds our money, so it can pay
  //     the beneficiary now; our wire replenishes the float behind the payout.
  //     This is the only real-time path for an unlicensed partner.
  if (capability.prefundedFloat) {
    const fundingCurrency =
      settles.find(c => context.converterSettlementCurrencies.has(c)) ?? payoutCurrency;

    const needsFx = fundingCurrency !== payoutCurrency;
    const rate = needsFx ? await context.getRate(fundingCurrency, payoutCurrency) : null;
    if (needsFx && (!Number.isFinite(rate as number) || (rate as number) <= 0)) {
      throw fundingError(
        `Cannot size ${fundingCurrency}→${payoutCurrency} replenishment for '${providerId}': ` +
        `FX lookup returned ${rate}.`,
      );
    }

    return {
      ...base,
      mode: 'PREFUNDED_FLOAT',
      settlementCurrency: fundingCurrency,
      settlementAmount: needsFx ? round(payoutAmount / (rate as number), 2) : payoutAmount,
      fxRate: rate,
      fxBearer: needsFx ? 'PARTNER' : 'NONE',
      requiresB2bConversion: true,
      payoutPrecedesFunding: true,
      rationale:
        `${providerId} holds a pre-funded ${payoutCurrency} float — the beneficiary is paid from ` +
        `float immediately and our ${fundingCurrency} wire replenishes it afterwards, so the ` +
        `funding leg is off the payout's critical path`,
    };
  }

  // 3 — partner takes the payout currency and our converter can produce it.
  if (settles.includes(payoutCurrency) && context.converterSettlementCurrencies.has(payoutCurrency)) {
    return {
      ...base,
      mode: 'DIRECT_FIAT',
      settlementCurrency: payoutCurrency,
      settlementAmount: payoutAmount,
      fxRate: null,
      fxBearer: 'NONE',
      requiresB2bConversion: true,
      payoutPrecedesFunding: false,
      rationale:
        `${providerId} is funded directly in ${payoutCurrency}; no FX at the partner. ` +
        `The beneficiary is paid only after our wire lands — this corridor is not real-time`,
    };
  }

  // 4 — bridge currency, partner applies its own FX.
  const bridgePreference = context.bridgePreference ?? DEFAULT_BRIDGE_PREFERENCE;
  const bridge = bridgePreference.find(
    c => settles.includes(c) && context.converterSettlementCurrencies.has(c),
  );

  if (bridge) {
    // Size the funding so the partner can deliver payoutAmount after its FX.
    // rate is bridge → payout, so settlementAmount = payoutAmount / rate.
    const rate = await context.getRate(bridge, payoutCurrency);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw fundingError(
        `Cannot size ${bridge}→${payoutCurrency} funding for '${providerId}': ` +
        `FX lookup returned ${rate}.`,
      );
    }
    const settlementAmount = round(payoutAmount / rate, 2);

    return {
      ...base,
      mode: 'PARTNER_FX',
      settlementCurrency: bridge,
      settlementAmount,
      fxRate: rate,
      fxBearer: 'PARTNER',
      requiresB2bConversion: true,
      payoutPrecedesFunding: false,
      rationale:
        `${providerId} cannot be funded in ${payoutCurrency}; funded in ${bridge} at an ` +
        `indicative ${bridge}/${payoutCurrency} of ${rate} — the partner applies its own FX, ` +
        `so the delivered amount is confirmed by the partner, not by us`,
    };
  }

  // No plan. Say precisely why, and what would fix it.
  throw fundingError(
    `No funding route to pay ${payoutAmount} ${payoutCurrency} via '${providerId}'. ` +
    `Partner accepts funding in: ${settles.join(', ') || 'nothing declared'}. ` +
    `Converter settles: ${[...context.converterSettlementCurrencies].join(', ')}. ` +
    `Fix by either (a) declaring a bridge currency the converter supports ` +
    `(${bridgePreference.join('/')}) in this provider's capability.settlementCurrencies, or ` +
    `(b) adding a converter that can produce ${payoutCurrency}.`,
  );
}

// ── Capability-based pre-filtering ────────────────────────────────────────────

/**
 * Cheap, allocation-free check run before `canHandle` so a provider that
 * structurally cannot serve this payout is never quoted.
 *
 * `canHandle` stays the authority on destination-field validation; this only
 * rejects on currency, method, country and amount limits.
 */
export function capabilityPermits(
  capability: ProviderCapability,
  payoutCurrency: string,
  amount: number,
  method?: PayoutMethod,
  countryCode?: string,
): boolean {
  const curr = payoutCurrency.toUpperCase();

  if (!capability.payoutCurrencies.map(c => c.toUpperCase()).includes(curr)) return false;
  if (method && !capability.methods.includes(method)) return false;

  if (countryCode && capability.countries?.length) {
    if (!capability.countries.map(c => c.toUpperCase()).includes(countryCode.toUpperCase())) {
      return false;
    }
  }

  const band = capability.limits?.[curr];
  if (band) {
    if (band.min !== undefined && amount < band.min) return false;
    if (band.max !== undefined && amount > band.max) return false;
  }

  return true;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fundingError(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'NO_FUNDING_ROUTE',
    statusCode: 422,
  });
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
