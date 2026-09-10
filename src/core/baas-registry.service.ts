/**
 * AxLink BaaS Registry — Fiat Delivery Router (JIT, zero pre-funded)
 *
 * ══════════════════════════════════════════════════════════════════════
 *  ZERO PRE-FUNDED CORRIDORS
 *
 *  AxLink never maintains standing fiat balances.
 *  Each withdrawal triggers a real-time USDT→fiat conversion (JIT):
 *
 *  Atomic providers (Thunes):
 *    deliverFiat → provider handles USDT conversion + delivery in one call
 *
 *  Two-phase providers (Daraja, ChoiceBank, Brainrock):
 *    deliverFiat → B2BinPay converts USDT→fiat → provider delivers fiat
 *
 *  No SWIFT. No pre-funded accounts. No capital locked.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Adding a new partner: create providers/<name>.baas.ts, add one line
 * in baas-bootstrap.ts. Nothing else changes.
 */

import { randomUUID } from 'crypto';
import { createPayout, calculatePayoutFee, B2B_SETTLEMENT_CURRENCIES } from '../providers/live/b2binpay';
import { createTransfer as fbTransfer } from '../providers/live/fireblocks';
import { getRate as fxRate } from './fx.service';
import {
  deriveCapability,
  evaluateCapability,
  resolveFundingPlan,
  type FundingPlan,
  type ProviderOperation,
  type ProviderEnvironment,
} from './provider/capability';
import {
  summarise,
  noRouteError,
  type RoutingDecision,
  type RejectedProvider,
} from './provider/decision';
import { checkAll } from './provider/health';
import { withBreaker, isAvailable, CircuitOpenError } from './provider/circuit-breaker';
import * as attempts from './provider/attempt.service';
import type {
  IBaaSProvider,
  PaymentDestination,
  BaaSQuote,
  BaaSPayoutParams,
  BaaSPayoutResult,
  CollectionRequest,
  CollectionResult,
  BeneficiaryVerdict,
} from './baas.interface';

const _providers: IBaaSProvider[] = [];
const QUOTE_TIMEOUT_MS = 4_000;

// B2BinPay JIT funding config
const B2B_WALLET_ID   = process.env.B2BINPAY_WALLET_ID        ?? '';
const TREASURY_VAULT  = process.env.FIREBLOCKS_TREASURY_VAULT  ?? '';
const USDT_ASSET      = process.env.FIREBLOCKS_USDT_ASSET      ?? 'USDT_SOL';
const CALLBACK        = `${process.env.API_BASE_URL}/webhooks/b2binpay`;

/**
 * Providers whose float-account variable does not follow the convention.
 *
 * These names predate the convention below and are set in deployed
 * environments, so they are honoured rather than renamed — an env var rename
 * is a coordinated deploy, and getting it wrong strands a payout.
 */
const LEGACY_FUNDING_ENV: Record<string, string> = {
  daraja:     'DARAJA_B2C_FLOAT_ACCOUNT',
  choicebank: 'CHOICEBANK_FLOAT_ACCOUNT',
  brainrock:  'BRAINROCK_TREASURY_ACCOUNT_ID',
  mtnmomo:    'MTN_FLOAT_ACCOUNT',
  orange:     'ORANGE_FLOAT_ACCOUNT',
};

/**
 * The account a partner is funded into before it can disburse.
 *
 * Resolved from the provider's own id — `<PROVIDER_ID>_FLOAT_ACCOUNT` — rather
 * than a map in core. A hard-coded map meant adding a provider required editing
 * this file, which is precisely the coupling the registry exists to remove: a
 * new partner would register, pass every capability check, win a route, and
 * then fail at funding because core had never heard of it.
 *
 * Read per call, not at import, so a corrected variable takes effect on the
 * next payment rather than the next restart.
 */
function fundingAccountFor(providerId: string): string {
  const legacy = LEGACY_FUNDING_ENV[providerId];
  if (legacy && process.env[legacy]) return process.env[legacy] as string;

  const conventional = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FLOAT_ACCOUNT`;
  return process.env[conventional] ?? '';
}

// ── Registry management ───────────────────────────────────────────────────────

/**
 * Which environment routing is running in.
 *
 * Read per call rather than captured at import, so it stays correctable — a
 * module-scope env read is a value nothing can fix without a restart, which is
 * exactly the class of bug that made TREASURY_VAULT permanently empty.
 */
function environment(): ProviderEnvironment {
  return process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
}

/** Providers switched off at runtime — see `setProviderEnabled`. */
const _disabled = new Set<string>();

/**
 * Register a provider.
 *
 * Declaring an operation you cannot perform is rejected here rather than
 * discovered when a payment is already in flight. A provider claiming PAYOUT
 * without `sendPayout` would pass every capability check, win the route, and
 * then fail with the customer's money already debited — so the registration
 * fails at boot instead, where it is one obvious error in a startup log.
 */
export function registerBaaSProvider(provider: IBaaSProvider): void {
  if (_providers.find(p => p.id === provider.id)) {
    throw new Error(`BaaS provider '${provider.id}' is already registered`);
  }

  const cap = deriveCapability(provider);
  const operations = cap.operations ?? ['PAYOUT'];

  if (operations.includes('PAYOUT') && typeof provider.sendPayout !== 'function') {
    throw new Error(
      `Provider '${provider.id}' declares the PAYOUT operation but implements no sendPayout(). ` +
      `It would win payout routing and fail after the customer was debited. ` +
      `Either implement sendPayout or remove PAYOUT from capability.operations.`,
    );
  }

  if (operations.includes('COLLECTION') && typeof provider.collect !== 'function') {
    throw new Error(
      `Provider '${provider.id}' declares the COLLECTION operation but implements no collect(). ` +
      `It would win collection routing and fail with a customer waiting to fund their account. ` +
      `Either implement collect or remove COLLECTION from capability.operations.`,
    );
  }

  _providers.push(provider);

  const env = cap.environments?.length ? cap.environments.join('/') : 'any';
  console.log(
    `[BaaSRegistry] Registered: ${provider.name} | currencies: ${provider.supportedCurrencies.join(', ')} ` +
    `| operations: ${operations.join(', ')} | env: ${env}`,
  );
}

export function getRegisteredProviders(): Array<{
  id: string; name: string; currencies: string[]; atomicJit: boolean;
  operations: string[]; environments: string[]; enabled: boolean;
}> {
  return _providers.map(p => {
    const cap = deriveCapability(p);
    return {
      id: p.id,
      name: p.name,
      currencies: p.supportedCurrencies,
      atomicJit: p.atomicJit ?? false,
      operations: cap.operations ?? ['PAYOUT'],
      environments: cap.environments ?? ['sandbox', 'production'],
      enabled: !_disabled.has(p.id),
    };
  });
}

/**
 * Turn a provider off without removing it.
 *
 * A partner having an incident needs to stop receiving traffic in seconds,
 * and the alternatives are worse: a deploy is too slow, and deleting the
 * registration loses the capability declaration needed to turn it back on.
 * Disabled providers still appear in routing decisions, marked DISABLED, so
 * "why did this route change" stays answerable.
 */
export function setProviderEnabled(providerId: string, enabled: boolean): void {
  if (!_providers.find(p => p.id === providerId)) {
    throw new Error(`Unknown provider '${providerId}'`);
  }
  if (enabled) _disabled.delete(providerId);
  else _disabled.add(providerId);
  console.warn(`[BaaSRegistry] Provider ${providerId} ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

export function isProviderEnabled(providerId: string): boolean {
  return !_disabled.has(providerId);
}

/**
 * One registered provider, by id.
 *
 * The settlement engine records which partner a withdrawal was routed to when
 * the legs are planned, then instructs that same partner once it has been
 * funded — possibly minutes later, possibly after a restart. It needs to
 * resolve the id it stored, and re-running selection would be wrong: the
 * cheapest provider now is not necessarily the one already holding the money.
 */
export function getProviderById(providerId: string): IBaaSProvider | undefined {
  return _providers.find(p => p.id === providerId);
}

/** Health for every registered provider. Concurrent; one bad probe cannot fail the rest. */
export function providerHealthReports() {
  return checkAll(_providers);
}

/**
 * Empty the registry. Tests only.
 *
 * Registration is process-global, so without this each test inherits the
 * providers of the one before it and routing assertions stop meaning anything.
 *
 * Guarded like the settlement ports: a process that can be talked into
 * forgetting its payment providers is worse than one that cannot be tested.
 * The check is at call time, not import, so the guard cannot be dodged by
 * setting the variable afterwards.
 */
export function resetRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to clear the provider registry: NODE_ENV is production');
  }
  _providers.length = 0;
  _disabled.clear();
}

// ── Provider selection ────────────────────────────────────────────────────────

async function getBestProvider(
  currency: string,
  amount: number,
  destination: PaymentDestination,
  operation: ProviderOperation = 'PAYOUT',
  environment?: ProviderEnvironment,
): Promise<{ provider: IBaaSProvider; quote: BaaSQuote; decision: RoutingDecision }> {
  const startedAt = Date.now();
  const correlationId = randomUUID();
  // Two filters before any network call.
  //
  // capabilityPermits() rejects on currency, method, country and amount limits
  // without allocating anything. canHandle() then validates the destination's
  // fields, which is the provider's own business and stays with it.
  //
  // isAvailable() drops providers whose circuit is open. Previously a partner
  // that was down was re-raced on every single payout, adding the full 4s quote
  // timeout to every payment until someone edited the bootstrap file.
  // Every provider that does not make the cut records why. Discarding the
  // reason is what makes "why did this go to B and not A" unanswerable later,
  // once limits have moved and breakers have closed again.
  const rejected: RejectedProvider[] = [];

  const structurallyCapable = _providers.filter(p => {
    if (!isProviderEnabled(p.id)) {
      rejected.push({ providerId: p.id, reason: 'DISABLED', detail: 'switched off at runtime' });
      return false;
    }

    const cap = deriveCapability(p);
    const verdict = evaluateCapability(cap, {
      operation,
      currency,
      amount,
      method: destination.method,
      countryCode: destination.countryCode,
      environment,
    });

    if (!verdict.permitted) {
      rejected.push({ providerId: p.id, reason: verdict.reason!, detail: verdict.detail });
      return false;
    }

    // canHandle validates the destination's own fields — the provider's
    // business, and the one check that stays with it.
    if (!p.canHandle(currency, destination)) {
      rejected.push({
        providerId: p.id,
        reason: 'METHOD_UNSUPPORTED',
        detail: 'destination fields not accepted by this provider',
      });
      return false;
    }

    return true;
  });

  const candidates = structurallyCapable.filter(p => isAvailable(p.id));

  const circuitOpen = structurallyCapable.filter(p => !isAvailable(p.id));
  for (const p of circuitOpen) {
    rejected.push({ providerId: p.id, reason: 'CIRCUIT_OPEN', detail: 'failing — breaker open' });
    void attempts.record({ providerId: p.id, operation: 'QUOTE', outcome: 'SKIPPED_CIRCUIT_OPEN', currency, amount });
  }

  const decisionSoFar = (selectedProviderId: string | null, matched: string[], basis?: string): RoutingDecision => ({
    correlationId,
    operation,
    currency,
    amount,
    selectedProviderId,
    matched,
    ...(basis ? { selectionBasis: basis } : {}),
    rejected,
    latencyMs: Date.now() - startedAt,
    decidedAt: new Date().toISOString(),
  });

  if (candidates.length === 0 && circuitOpen.length > 0) {
    throw Object.assign(
      new Error(
        `Every provider able to handle ${currency} is currently circuit-broken: ` +
        `${circuitOpen.map(p => p.id).join(', ')}. They are failing, not missing — ` +
        `check partner status before changing routing.`,
      ),
      { code: 'ALL_PROVIDERS_UNAVAILABLE', statusCode: 503, decision: decisionSoFar(null, []) },
    );
  }

  if (candidates.length === 0) {
    // Carries every rejection, so the answer is "Daraja does not cover NG,
    // Choice Bank's maximum is 500000" rather than "no provider available".
    throw noRouteError(decisionSoFar(null, []));
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    const cap = deriveCapability(only);
    const verdict = evaluateCapability(cap, {
      operation, currency, amount, method: destination.method,
      countryCode: destination.countryCode, environment,
    });
    const quote = await attempts.timed(
      { providerId: only.id, operation: 'QUOTE', currency, amount, selected: true },
      () => withBreaker(only.id, () => only.getQuote(currency, amount, destination)),
    );
    return {
      provider: only,
      quote,
      decision: decisionSoFar(only.id, verdict.matched, 'only capable provider'),
    };
  }

  // Race quotes from all candidates in parallel, pick lowest fee
  const settled = await Promise.allSettled(
    candidates.map(async p => {
      const timeoutP = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`${p.id} quote timed out`)), QUOTE_TIMEOUT_MS),
      );
      const quote = await attempts.timed(
        { providerId: p.id, operation: 'QUOTE', currency, amount },
        () => withBreaker(p.id, () => Promise.race([p.getQuote(currency, amount, destination), timeoutP])),
      );
      return { provider: p, quote };
    }),
  );

  const successful = settled
    .filter((r): r is PromiseFulfilledResult<{ provider: IBaaSProvider; quote: BaaSQuote }> =>
      r.status === 'fulfilled',
    )
    .map(r => r.value);

  if (successful.length === 0) {
    // Separate "the partner said no" from "we never asked". Reporting a
    // circuit-open skip as a quote failure sends whoever is on call looking at
    // the wrong system.
    const circuitOpen = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof CircuitOpenError,
    );
    if (circuitOpen.length === settled.length) {
      throw Object.assign(
        new Error(`All providers for ${currency} are circuit-broken — none were called`),
        { code: 'ALL_PROVIDERS_UNAVAILABLE', statusCode: 503 },
      );
    }

    const reasons = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => r.reason instanceof Error ? r.reason.message : String(r.reason));
    throw new Error(`All BaaS providers failed to quote for ${currency}: ${reasons.join('; ')}`);
  }

  // A provider that could serve the request but failed to quote belongs in the
  // rejection list too — it was considered and passed over, and "it timed out"
  // is a different fact from "it does not cover this country".
  candidates
    .filter(c => !successful.some(s => s.provider.id === c.id))
    .forEach(c => rejected.push({
      providerId: c.id,
      reason: 'QUOTE_FAILED',
      detail: 'did not return a quote in time',
    }));

  // Lowest fee first; tie → fastest delivery
  successful.sort((a, b) => {
    const diff = a.quote.fee - b.quote.fee;
    if (Math.abs(diff) > 0.001) return diff;
    return a.quote.estimatedMinutes - b.quote.estimatedMinutes;
  });

  const winner = successful[0];
  const runnersUp = successful.slice(1);

  // Losing on price is a rejection like any other. Without this, a decision
  // shows one winner and no trace of the alternative that was 0.001 dearer.
  runnersUp.forEach(s => rejected.push({
    providerId: s.provider.id,
    reason: 'QUOTE_FAILED',
    detail: `quoted $${s.quote.fee.toFixed(3)} vs winner $${winner.quote.fee.toFixed(3)}`,
  }));

  const basis = runnersUp.length
    ? `cheapest of ${successful.length}: $${winner.quote.fee.toFixed(3)} vs ${runnersUp.map(s => `${s.provider.id} $${s.quote.fee.toFixed(3)}`).join(', ')}`
    : 'only provider to return a quote';

  const winnerCap = deriveCapability(winner.provider);
  const winnerVerdict = evaluateCapability(winnerCap, {
    operation, currency, amount, method: destination.method,
    countryCode: destination.countryCode, environment,
  });

  const decision = decisionSoFar(winner.provider.id, winnerVerdict.matched, basis);
  console.log(`[BaaSRegistry] ${summarise(decision)}`);

  return { provider: winner.provider, quote: winner.quote, decision };
}

// ── Beneficiary validation ────────────────────────────────────────────────────

/**
 * Resolve a beneficiary through a partner that can, before any money moves.
 *
 * Intended to be called by the platform while the sender is still on screen:
 * an account number can be perfectly valid and belong to the wrong person, and
 * the name on it is the only thing that distinguishes those two cases. After
 * settlement it is a recovery problem; before it, it is a confirm dialog.
 *
 * Deliberately not called automatically inside deliverFiat. Validation is a
 * decision about whether to proceed, which belongs to whoever can ask the
 * sender — not to the code already committed to paying.
 *
 * Never reports `verified: true` on an absent capability or a failed call. A
 * provider that cannot validate yields "unknown", and unknown must not read as
 * a pass.
 */
export async function validateBeneficiary(
  currency: string,
  destination: PaymentDestination,
): Promise<BeneficiaryVerdict & { providerId: string | null }> {
  const curr = currency.toUpperCase();

  const capable = _providers.filter(p => {
    if (!isProviderEnabled(p.id) || typeof p.validateBeneficiary !== 'function') return false;
    const verdict = evaluateCapability(deriveCapability(p), {
      operation: 'PAYOUT',
      currency: curr,
      method: destination.method,
      countryCode: destination.countryCode,
      environment: environment(),
    });
    return verdict.permitted && p.canHandle(curr, destination);
  });

  if (capable.length === 0) {
    return {
      providerId: null,
      verified: false,
      reason: `No provider able to validate a ${curr} beneficiary on this rail`,
    };
  }

  const provider = capable[0];
  try {
    const verdict = await withBreaker(provider.id, () =>
      provider.validateBeneficiary!({ currency: curr, destination }),
    );
    return { ...verdict, providerId: provider.id };
  } catch (err) {
    // A partner that errored has told us nothing about the account. Reporting
    // that as unverified is correct; reporting it as verified would be the
    // single most expensive lie this function could tell.
    return {
      providerId: provider.id,
      verified: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Collection ────────────────────────────────────────────────────────────────

/**
 * Ask a partner to take money in.
 *
 * Selection shares `evaluateCapability` with payouts, but nothing else:
 * collection has no funding leg — no USDT to move, no float to replenish,
 * because the money is arriving rather than leaving — and partners expose no
 * collection quote, so there is no race to run. Reusing the payout path would
 * mean pretending both.
 *
 * Selection is therefore by declared capability and availability alone. Where
 * more than one partner qualifies, the cheaper declared fee wins; the decision
 * records the rest.
 */
export async function collectFunds(
  request: CollectionRequest,
): Promise<CollectionResult & { decision: RoutingDecision }> {
  const startedAt = Date.now();
  const correlationId = randomUUID();
  const curr = request.currency.toUpperCase();
  const rejected: RejectedProvider[] = [];

  const candidates = _providers.filter(p => {
    if (!isProviderEnabled(p.id)) {
      rejected.push({ providerId: p.id, reason: 'DISABLED', detail: 'switched off at runtime' });
      return false;
    }

    const verdict = evaluateCapability(deriveCapability(p), {
      operation: 'COLLECTION',
      currency: curr,
      // Passed through undefined, not coerced: a standing instrument names no
      // figure, and zero would fail every declared minimum.
      amount: request.amount,
      countryCode: request.countryCode,
      environment: environment(),
    });

    if (!verdict.permitted) {
      rejected.push({ providerId: p.id, reason: verdict.reason!, detail: verdict.detail });
      return false;
    }

    if (!isAvailable(p.id)) {
      rejected.push({ providerId: p.id, reason: 'CIRCUIT_OPEN', detail: 'failing — breaker open' });
      return false;
    }

    return true;
  });

  const decisionFor = (selected: string | null, matched: string[], basis?: string): RoutingDecision => ({
    correlationId,
    operation: 'COLLECTION',
    currency: curr,
    amount: request.amount ?? 0,
    selectedProviderId: selected,
    matched,
    ...(basis ? { selectionBasis: basis } : {}),
    rejected,
    latencyMs: Date.now() - startedAt,
    decidedAt: new Date().toISOString(),
  });

  if (candidates.length === 0) throw noRouteError(decisionFor(null, []));

  // Declared fee, not a quoted one: partners price collection as a published
  // schedule rather than per request, so asking each one would be a network
  // round trip for a number already in the capability.
  const ranked = [...candidates].sort((a, b) => {
    const fa = deriveCapability(a).fees?.percent ?? deriveCapability(a).fees?.fixedUsd ?? 0;
    const fb = deriveCapability(b).fees?.percent ?? deriveCapability(b).fees?.fixedUsd ?? 0;
    return fa - fb;
  });

  const winner = ranked[0];
  ranked.slice(1).forEach(p =>
    rejected.push({ providerId: p.id, reason: 'QUOTE_FAILED', detail: 'higher declared collection fee' }),
  );

  const verdict = evaluateCapability(deriveCapability(winner), {
    operation: 'COLLECTION',
    currency: curr,
    amount: request.amount,
    countryCode: request.countryCode,
    environment: environment(),
  });

  const decision = decisionFor(
    winner.id,
    verdict.matched,
    ranked.length > 1 ? `lowest declared fee of ${ranked.length}` : 'only capable provider',
  );
  console.log(`[BaaSRegistry] ${summarise(decision)}`);

  // Registration guarantees this, so its absence means the registry was
  // bypassed. Assert rather than assume.
  const collect = winner.collect?.bind(winner);
  if (!collect) {
    throw Object.assign(
      new Error(`Provider '${winner.id}' was routed a collection but implements no collect()`),
      { code: 'PROVIDER_CANNOT_COLLECT', statusCode: 500 },
    );
  }

  const result = await attempts.timed(
    {
      providerId: winner.id,
      operation: 'QUOTE',
      reference: request.reference,
      currency: curr,
      amount: request.amount,
      selected: true,
    },
    () => withBreaker(winner.id, () => collect({ ...request, currency: curr })),
  );

  return { ...result, decision };
}

// ── JIT two-phase funding ─────────────────────────────────────────────────────
// Only called for non-atomic providers.
// B2BinPay converts USDT → local fiat and sends to the provider's AxLink account.

async function jitFundProvider(params: {
  plan:        FundingPlan;
  usdtAmount:  number;
  reference:   string;
}): Promise<string> {
  const { plan, usdtAmount, reference } = params;
  const providerId = plan.providerId;
  // Fund in the SETTLEMENT currency the plan chose, which is not necessarily
  // the payout currency. That distinction is the whole point of the plan: a
  // partner delivering KES is funded in USD and applies its own FX.
  const currency = plan.settlementCurrency;
  const amount   = plan.settlementAmount;

  const fundingAddress = fundingAccountFor(providerId);
  if (!fundingAddress) {
    const expected = LEGACY_FUNDING_ENV[providerId]
      ?? `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FLOAT_ACCOUNT`;
    throw new Error(
      `No funding account configured for provider '${providerId}'. Set ${expected} — ` +
      `it is the account the converter wires settlement funds to before this partner can disburse.`,
    );
  }

  // The plan guarantees the converter can produce this currency; assert it so a
  // future planner change cannot quietly strand USDT in the converter's wallet.
  if (!B2B_SETTLEMENT_CURRENCIES.has(currency)) {
    throw new Error(
      `Funding plan for '${providerId}' chose settlement currency ${currency}, which the ` +
      `converter cannot produce (it settles ${[...B2B_SETTLEMENT_CURRENCIES].join(', ')}). ` +
      `This is a planner bug — resolveFundingPlan should never emit it.`,
    );
  }

  // Move USDT from treasury → B2BinPay wallet for conversion
  await fbTransfer({
    assetId:       USDT_ASSET,
    amount:        usdtAmount.toString(),
    sourceVaultId: TREASURY_VAULT,
    destVaultId:   B2B_WALLET_ID,
    note:          `JIT fund ${providerId} corridor — ${amount} ${currency} | ref ${reference}`,
    externalTxId:  `jit_${reference}`,
  });

  // B2BinPay converts USDT → local fiat, sends to provider's AxLink account
  const estimate = await calculatePayoutFee({
    walletId:   B2B_WALLET_ID,
    address:    fundingAddress,
    amount:     amount.toString(),
    currencyId: currency,
  });

  const jitPayout = await createPayout({
    walletId:       B2B_WALLET_ID,
    currencyId:     currency,
    address:        fundingAddress,
    amount:         amount.toString(),
    feeAmount:      estimate.fee.medium,
    trackingId:     `jit_${reference}`,
    callbackUrl:    `${CALLBACK}?type=jit&reference=${reference}&provider=${providerId}`,
    idempotencyKey: randomUUID(),
    label:          `AxLink JIT: ${usdtAmount} USDT → ${amount} ${currency} → ${providerId}`,
  });

  console.log(
    `[BaaSRegistry] JIT funded ${providerId}: ` +
    `${usdtAmount} USDT → ${amount} ${currency} (b2bPayoutId=${jitPayout.id})`,
  );

  return jitPayout.id;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Deliver fiat to a recipient via the best available BaaS provider.
 *
 * - Selects the cheapest/fastest provider that can handle this currency+method
 * - Handles JIT funding automatically (no pre-funded corridors)
 * - Atomic providers: one API call does everything
 * - Two-phase providers: B2BinPay funds → provider delivers
 *
 * @param usdtAmount  The USDT amount already collected in AxLink treasury vault.
 *                    Required for JIT funding of two-phase providers.
 */
export async function deliverFiat(params: {
  currency:    string;
  amount:      number;
  usdtAmount:  number;
  destination: PaymentDestination;
  reference:   string;
  description: string;
}): Promise<{ provider: string; paymentId: string; estimatedMinutes?: number; plan: FundingPlan; decision: RoutingDecision }> {
  const { currency, amount, usdtAmount, destination, reference, description } = params;
  const curr = currency.toUpperCase();

  const { provider, decision } = await getBestProvider(curr, amount, destination, 'PAYOUT', environment());

  // Decide HOW to fund this partner before moving anything. resolveFundingPlan
  // throws if no route exists, which is deliberately before any USDT leaves the
  // treasury — the previous code could move USDT and only then discover the
  // converter could not produce the payout currency, stranding it.
  const plan = await resolveFundingPlan({
    providerId: provider.id,
    capability: deriveCapability(provider),
    payoutCurrency: curr,
    payoutAmount: amount,
    usdtAmount,
    context: {
      converterSettlementCurrencies: B2B_SETTLEMENT_CURRENCIES,
      getRate: fxRate,
    },
  });

  console.log(`[BaaSRegistry] Funding plan for ${reference}: ${plan.rationale}`);

  let jitPayoutId: string | undefined;

  // PREFUNDED_FLOAT pays the beneficiary FIRST from float the partner already
  // holds, and replenishes afterwards. Funding before payout in that mode would
  // throw away the only reason to hold float.
  if (plan.requiresB2bConversion && !plan.payoutPrecedesFunding) {
    jitPayoutId = await attempts.timed(
      {
        providerId: provider.id,
        operation: 'FUND',
        reference,
        currency: plan.settlementCurrency,
        amount: plan.settlementAmount,
        plan,
      },
      () => jitFundProvider({ plan, usdtAmount, reference }),
    );
  }

  const payoutParams: BaaSPayoutParams = {
    currency: curr, amount, destination, reference, description,
    ...(plan.mode === 'ATOMIC_USDT' ? { usdtAmount } : {}),
  };

  // Registration rejects a PAYOUT provider without sendPayout, so reaching here
  // without one means the registry was bypassed. Assert rather than assume: the
  // alternative is a crash after the customer has already been debited.
  const send = provider.sendPayout?.bind(provider);
  if (!send) {
    throw Object.assign(
      new Error(`Provider '${provider.id}' was routed a payout but implements no sendPayout()`),
      { code: 'PROVIDER_CANNOT_PAYOUT', statusCode: 500 },
    );
  }

  const result: BaaSPayoutResult = await attempts.timed(
    { providerId: provider.id, operation: 'PAYOUT', reference, currency: curr, amount, plan, selected: true },
    () => withBreaker(provider.id, () => send(payoutParams)),
  );

  // Replenishment runs after the beneficiary has been paid, and must not fail
  // the payout: the customer has their money either way, and a failed
  // replenishment is a treasury problem, surfaced by the float reconciliation.
  if (plan.requiresB2bConversion && plan.payoutPrecedesFunding) {
    jitFundProvider({ plan, usdtAmount, reference })
      .then(id => { jitPayoutId = id; })
      .catch(err =>
        console.error(
          `[BaaSRegistry] Float replenishment FAILED for ${provider.id} ref ${reference}: ` +
          `${(err as Error).message} — beneficiary was paid from float, which is now short ` +
          `${plan.settlementAmount} ${plan.settlementCurrency}`,
        ),
      );
  }

  console.log(
    `[BaaSRegistry] Delivered ${amount} ${curr} via ${provider.id} ` +
    `(paymentId=${result.paymentId}${jitPayoutId ? `, jitRef=${jitPayoutId}` : ''})`,
  );

  return {
    provider:         provider.id,
    paymentId:        result.paymentId,
    estimatedMinutes: result.estimatedMinutes,
    plan,
    decision,
  };
}

/**
 * List which providers can handle a given currency and method.
 * Used by the rate feed endpoint so banks know what's available.
 */
export function getCapableProviders(
  currency: string,
  destination?: Partial<PaymentDestination>,
): Array<{ id: string; name: string; atomicJit: boolean }> {
  return _providers
    .filter(p => p.canHandle(currency, (destination ?? {}) as PaymentDestination))
    .map(p => ({ id: p.id, name: p.name, atomicJit: p.atomicJit ?? false }));
}

/**
 * List all supported currencies across all registered providers,
 * grouped by method. Used for the "what can I deposit/withdraw" UI.
 */
export function getSupportedCorridors(): Record<string, { providers: string[]; methods: string[] }> {
  const result: Record<string, { providers: Set<string>; methods: Set<string> }> = {};

  for (const provider of _providers) {
    for (const currency of provider.supportedCurrencies) {
      if (!result[currency]) result[currency] = { providers: new Set(), methods: new Set() };
      result[currency].providers.add(provider.id);
      // Infer available methods from canHandle probes
      const probes: Array<[string, Partial<PaymentDestination>]> = [
        ['mobile_money', { method: 'mobile_money', mobileNumber: '+1' }],
        ['bank_transfer', { method: 'bank_transfer', accountNumber: '123', bankCode: '001' }],
        ['iban',          { method: 'bank_transfer', iban: 'GB123' }],
      ];
      for (const [method, dest] of probes) {
        if (provider.canHandle(currency, dest as PaymentDestination)) {
          result[currency].methods.add(method);
        }
      }
    }
  }

  return Object.fromEntries(
    Object.entries(result).map(([k, v]) => [
      k,
      { providers: [...v.providers], methods: [...v.methods] },
    ]),
  );
}
