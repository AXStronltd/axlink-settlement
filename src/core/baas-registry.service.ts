/**
 * AxLink BaaS Registry — Fiat Delivery Router (JIT, zero pre-funded)
 *
 * ══════════════════════════════════════════════════════════════════════
 *  ZERO PRE-FUNDED CORRIDORS
 *
 *  FinCruse never maintains standing fiat balances.
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
import { createPayout, calculatePayoutFee } from '../providers/live/b2binpay';
import { createTransfer as fbTransfer } from '../providers/live/fireblocks';
import type {
  IBaaSProvider,
  PaymentDestination,
  BaaSQuote,
  BaaSPayoutParams,
  BaaSPayoutResult,
} from './baas.interface';

const _providers: IBaaSProvider[] = [];
const QUOTE_TIMEOUT_MS = 4_000;

// B2BinPay JIT funding config
const B2B_WALLET_ID   = process.env.B2BINPAY_WALLET_ID        ?? '';
const TREASURY_VAULT  = process.env.FIREBLOCKS_TREASURY_VAULT  ?? '';
const USDT_ASSET      = process.env.FIREBLOCKS_USDT_ASSET      ?? 'USDT_SOL';
const CALLBACK        = `${process.env.API_BASE_URL}/webhooks/b2binpay`;

// Maps each two-phase provider ID to the AxLink account address that B2BinPay
// sends fiat to before that provider can disburse.
const PROVIDER_FUNDING_ADDRESS: Record<string, string> = {
  daraja:      process.env.DARAJA_B2C_FLOAT_ACCOUNT    ?? '',
  choicebank:  process.env.CHOICEBANK_FLOAT_ACCOUNT    ?? '',
  brainrock:   process.env.BRAINROCK_TREASURY_ACCOUNT_ID ?? '',
  mtnmomo:     process.env.MTN_FLOAT_ACCOUNT           ?? '',
  orange:      process.env.ORANGE_FLOAT_ACCOUNT        ?? '',
};

// ── Registry management ───────────────────────────────────────────────────────

export function registerBaaSProvider(provider: IBaaSProvider): void {
  if (_providers.find(p => p.id === provider.id)) {
    throw new Error(`BaaS provider '${provider.id}' is already registered`);
  }
  _providers.push(provider);
  console.log(`[BaaSRegistry] Registered: ${provider.name} | currencies: ${provider.supportedCurrencies.join(', ')} | JIT: ${provider.atomicJit ? 'atomic' : 'two-phase'}`);
}

export function getRegisteredProviders(): Array<{ id: string; name: string; currencies: string[]; atomicJit: boolean }> {
  return _providers.map(p => ({ id: p.id, name: p.name, currencies: p.supportedCurrencies, atomicJit: p.atomicJit }));
}

// ── Provider selection ────────────────────────────────────────────────────────

async function getBestProvider(
  currency: string,
  amount: number,
  destination: PaymentDestination,
): Promise<{ provider: IBaaSProvider; quote: BaaSQuote }> {
  const candidates = _providers.filter(p => p.canHandle(currency, destination));

  if (candidates.length === 0) {
    const method = destination.method ?? 'unspecified';
    const mobile = destination.mobileProvider ? ` (${destination.mobileProvider})` : '';
    throw new Error(
      `No BaaS provider available for ${currency} via ${method}${mobile}. ` +
      `Check that the destination has the required fields (mobileNumber, accountNumber+bankCode, IBAN, etc.). ` +
      `Registered providers: ${_providers.map(p => p.id).join(', ') || 'none'}`,
    );
  }

  if (candidates.length === 1) {
    const quote = await candidates[0].getQuote(currency, amount, destination);
    return { provider: candidates[0], quote };
  }

  // Race quotes from all candidates in parallel, pick lowest fee
  const settled = await Promise.allSettled(
    candidates.map(async p => {
      const timeoutP = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`${p.id} quote timed out`)), QUOTE_TIMEOUT_MS),
      );
      const quote = await Promise.race([p.getQuote(currency, amount, destination), timeoutP]);
      return { provider: p, quote };
    }),
  );

  const successful = settled
    .filter((r): r is PromiseFulfilledResult<{ provider: IBaaSProvider; quote: BaaSQuote }> =>
      r.status === 'fulfilled',
    )
    .map(r => r.value);

  if (successful.length === 0) {
    const reasons = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => r.reason instanceof Error ? r.reason.message : String(r.reason));
    throw new Error(`All BaaS providers failed to quote for ${currency}: ${reasons.join('; ')}`);
  }

  // Lowest fee first; tie → fastest delivery
  successful.sort((a, b) => {
    const diff = a.quote.fee - b.quote.fee;
    if (Math.abs(diff) > 0.001) return diff;
    return a.quote.estimatedMinutes - b.quote.estimatedMinutes;
  });

  const winner = successful[0];
  const skipped = successful.slice(1).map(s => `${s.provider.id}($${s.quote.fee.toFixed(3)})`).join(', ');
  console.log(
    `[BaaSRegistry] Winner for ${currency}: ${winner.provider.id} ` +
    `fee=$${winner.quote.fee.toFixed(3)} ~${winner.quote.estimatedMinutes}min` +
    (skipped ? ` | dropped: ${skipped}` : ''),
  );

  return winner;
}

// ── JIT two-phase funding ─────────────────────────────────────────────────────
// Only called for non-atomic providers.
// B2BinPay converts USDT → local fiat and sends to the provider's AxLink account.

async function jitFundProvider(params: {
  providerId:  string;
  currency:    string;
  amount:      number;
  usdtAmount:  number;
  reference:   string;
}): Promise<string> {
  const { providerId, currency, amount, usdtAmount, reference } = params;

  const fundingAddress = PROVIDER_FUNDING_ADDRESS[providerId];
  if (!fundingAddress) {
    throw new Error(
      `JIT funding address not configured for provider '${providerId}'. ` +
      `Set the corresponding env var (e.g. DARAJA_B2C_FLOAT_ACCOUNT).`,
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
}): Promise<{ provider: string; paymentId: string; estimatedMinutes?: number }> {
  const { currency, amount, usdtAmount, destination, reference, description } = params;
  const curr = currency.toUpperCase();

  const { provider } = await getBestProvider(curr, amount, destination);

  let jitPayoutId: string | undefined;

  if (!provider.atomicJit) {
    // Two-phase: B2BinPay converts USDT → fiat → provider's AxLink account
    jitPayoutId = await jitFundProvider({
      providerId: provider.id,
      currency:   curr,
      amount,
      usdtAmount,
      reference,
    });
  }

  const payoutParams: BaaSPayoutParams = {
    currency: curr, amount, destination, reference, description,
    ...(provider.atomicJit ? { usdtAmount } : {}),
  };

  const result: BaaSPayoutResult = await provider.sendPayout(payoutParams);

  console.log(
    `[BaaSRegistry] Delivered ${amount} ${curr} via ${provider.id} ` +
    `(paymentId=${result.paymentId}${jitPayoutId ? `, jitRef=${jitPayoutId}` : ''})`,
  );

  return {
    provider:         provider.id,
    paymentId:        result.paymentId,
    estimatedMinutes: result.estimatedMinutes,
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
    .map(p => ({ id: p.id, name: p.name, atomicJit: p.atomicJit }));
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
