import { describe, it, expect } from 'vitest';
import {
  resolveFundingPlan,
  deriveCapability,
  capabilityPermits,
  type ProviderCapability,
  type FundingContext,
} from '../core/provider/capability';
import type { IBaaSProvider } from '../core/baas.interface';

const CONVERTER_SETTLES = new Set(['USD', 'EUR', 'GBP', 'BTC', 'ETH', 'SOL', 'USDT']);

const ctx = (rate = 129): FundingContext => ({
  converterSettlementCurrencies: CONVERTER_SETTLES,
  getRate: async () => rate,
});

const plan = (capability: ProviderCapability, payoutCurrency = 'KES', payoutAmount = 12_900) =>
  resolveFundingPlan({
    providerId: 'test-partner',
    capability,
    payoutCurrency,
    payoutAmount,
    usdtAmount: 100,
    context: ctx(),
  });

describe('resolveFundingPlan', () => {
  // The corridor that was unreachable before: a partner that delivers KES but
  // can only be funded in USD, against a converter that settles USD/EUR/GBP.
  it('funds a local-currency corridor through a USD bridge', async () => {
    const result = await plan({
      settlementCurrencies: ['USD'],
      payoutCurrencies: ['KES'],
      methods: ['mobile_money'],
      partnerAppliesFx: true,
      cryptoLicensed: false,
    });

    expect(result.mode).toBe('PARTNER_FX');
    expect(result.settlementCurrency).toBe('USD');
    expect(result.payoutCurrency).toBe('KES');
    // 12,900 KES at 129 KES/USD = 100 USD
    expect(result.settlementAmount).toBe(100);
    expect(result.fxBearer).toBe('PARTNER');
    expect(result.requiresB2bConversion).toBe(true);
  });

  it('funds directly when the partner takes the payout currency', async () => {
    const result = await plan(
      {
        settlementCurrencies: ['USD', 'EUR', 'GBP'],
        payoutCurrencies: ['USD'],
        methods: ['bank_transfer'],
        cryptoLicensed: false,
      },
      'USD',
      500,
    );

    expect(result.mode).toBe('DIRECT_FIAT');
    expect(result.settlementCurrency).toBe('USD');
    expect(result.settlementAmount).toBe(500);
    expect(result.fxBearer).toBe('NONE');
  });

  it('uses USDT only for a partner that is explicitly crypto-licensed', async () => {
    const result = await plan({
      settlementCurrencies: ['USDT'],
      payoutCurrencies: ['KES'],
      methods: ['mobile_money'],
      cryptoLicensed: true,
    });

    expect(result.mode).toBe('ATOMIC_USDT');
    expect(result.settlementAmount).toBe(100);
    expect(result.requiresB2bConversion).toBe(false);
  });

  // The compliance guardrail. A partner without a VASP registration must never
  // be sent crypto, even if its capability lists USDT.
  it('refuses to send USDT to a partner that is not crypto-licensed', async () => {
    await expect(
      plan({
        settlementCurrencies: ['USDT'],
        payoutCurrencies: ['KES'],
        methods: ['mobile_money'],
        cryptoLicensed: false,
      }),
    ).rejects.toThrow(/not marked cryptoLicensed/);
  });

  it('refuses when cryptoLicensed is merely unset, rather than assuming', async () => {
    await expect(
      plan({
        settlementCurrencies: ['USDT'],
        payoutCurrencies: ['KES'],
        methods: ['mobile_money'],
      }),
    ).rejects.toThrow(/cryptoLicensed/);
  });

  // Pre-funded float is the only way an unlicensed partner pays a beneficiary
  // in real time, so the plan must say the payout precedes the funding.
  it('marks a pre-funded corridor as paying before it funds', async () => {
    const result = await plan({
      settlementCurrencies: ['USD'],
      payoutCurrencies: ['KES'],
      methods: ['mobile_money'],
      cryptoLicensed: false,
      prefundedFloat: true,
    });

    expect(result.mode).toBe('PREFUNDED_FLOAT');
    expect(result.payoutPrecedesFunding).toBe(true);
    expect(result.settlementCurrency).toBe('USD');
  });

  it('leaves a JIT-wired corridor on the payout critical path', async () => {
    const result = await plan({
      settlementCurrencies: ['USD'],
      payoutCurrencies: ['KES'],
      methods: ['mobile_money'],
      cryptoLicensed: false,
      prefundedFloat: false,
    });

    expect(result.payoutPrecedesFunding).toBe(false);
  });

  it('explains what would fix an impossible corridor instead of failing blankly', async () => {
    await expect(
      plan({
        settlementCurrencies: ['NGN'],
        payoutCurrencies: ['KES'],
        methods: ['mobile_money'],
        cryptoLicensed: false,
      }),
    ).rejects.toThrow(/No funding route|Partner accepts funding in/);
  });

  it('rejects a nonsensical FX rate rather than sizing a payment from it', async () => {
    await expect(
      resolveFundingPlan({
        providerId: 'test-partner',
        capability: {
          settlementCurrencies: ['USD'],
          payoutCurrencies: ['KES'],
          methods: ['mobile_money'],
          cryptoLicensed: false,
        },
        payoutCurrency: 'KES',
        payoutAmount: 12_900,
        usdtAmount: 100,
        context: { converterSettlementCurrencies: CONVERTER_SETTLES, getRate: async () => 0 },
      }),
    ).rejects.toThrow(/FX lookup returned 0/);
  });
});

describe('deriveCapability', () => {
  const legacy = (atomicJit: boolean, currencies: string[]): IBaaSProvider =>
    ({
      id: 'legacy',
      name: 'Legacy',
      supportedCurrencies: currencies,
      atomicJit,
      canHandle: () => true,
      getQuote: async () => ({}) as never,
      sendPayout: async () => ({}) as never,
    }) as unknown as IBaaSProvider;

  it('keeps a two-phase provider funded in its payout currency', () => {
    const cap = deriveCapability(legacy(false, ['GBP', 'USD']));
    expect(cap.settlementCurrencies).toEqual(['GBP', 'USD']);
    expect(cap.payoutCurrencies).toEqual(['GBP', 'USD']);
  });

  // Crypto licensing is a legal fact about a counterparty and cannot be
  // inferred from a boolean about API shape. A legacy atomicJit provider must
  // fail closed until someone confirms the licence.
  it('never infers a crypto licence from atomicJit', async () => {
    const cap = deriveCapability(legacy(true, ['XOF']));
    expect(cap.settlementCurrencies).toEqual(['USDT']);
    expect(cap.cryptoLicensed).toBeUndefined();

    await expect(
      resolveFundingPlan({
        providerId: 'legacy',
        capability: cap,
        payoutCurrency: 'XOF',
        payoutAmount: 1000,
        usdtAmount: 2,
        context: ctx(),
      }),
    ).rejects.toThrow(/cryptoLicensed/);
  });

  it('prefers a capability the provider declares over the legacy fields', () => {
    const declared: ProviderCapability = {
      settlementCurrencies: ['USD'],
      payoutCurrencies: ['KES'],
      methods: ['mobile_money'],
      cryptoLicensed: false,
    };
    const provider = { ...legacy(true, ['KES']), capability: declared } as IBaaSProvider;
    expect(deriveCapability(provider)).toBe(declared);
  });
});

describe('capabilityPermits', () => {
  const cap: ProviderCapability = {
    settlementCurrencies: ['USD'],
    payoutCurrencies: ['KES', 'UGX'],
    methods: ['mobile_money'],
    countries: ['KE', 'UG'],
    limits: { KES: { min: 100, max: 500_000 } },
  };

  it('accepts a payout inside every declared bound', () => {
    expect(capabilityPermits(cap, 'KES', 5_000, 'mobile_money', 'KE')).toBe(true);
  });

  it('rejects an undeclared currency', () => {
    expect(capabilityPermits(cap, 'NGN', 5_000, 'mobile_money', 'NG')).toBe(false);
  });

  it('rejects an unsupported method', () => {
    expect(capabilityPermits(cap, 'KES', 5_000, 'bank_transfer', 'KE')).toBe(false);
  });

  it('rejects a country outside the declared list', () => {
    expect(capabilityPermits(cap, 'KES', 5_000, 'mobile_money', 'TZ')).toBe(false);
  });

  it('enforces amount limits at both ends', () => {
    expect(capabilityPermits(cap, 'KES', 50, 'mobile_money', 'KE')).toBe(false);
    expect(capabilityPermits(cap, 'KES', 600_000, 'mobile_money', 'KE')).toBe(false);
  });

  it('treats an omitted country list as unrestricted', () => {
    const anywhere: ProviderCapability = { ...cap, countries: undefined };
    expect(capabilityPermits(anywhere, 'KES', 5_000, 'mobile_money', 'ZA')).toBe(true);
  });
});

describe('funding currency preference', () => {
  // The rule: we wire USD to every payout partner unless that partner is a
  // EUR or GBP partner. Both funding paths must agree on it, and neither may
  // depend on the order a provider file happens to declare its currencies in.
  const scrambled = ['GBP', 'EUR', 'USD'];

  it('wires USD to a prefunded partner even when its list starts with GBP', async () => {
    const result = await plan({
      settlementCurrencies: scrambled,
      payoutCurrencies: ['JPY'],
      methods: ['bank_transfer'],
      partnerAppliesFx: true,
      prefundedFloat: true,
      cryptoLicensed: false,
    }, 'JPY', 100_000);

    expect(result.mode).toBe('PREFUNDED_FLOAT');
    expect(result.settlementCurrency).toBe('USD');
  });

  it('wires USD on the bridge path too, from the same scrambled list', async () => {
    const result = await plan({
      settlementCurrencies: scrambled,
      payoutCurrencies: ['JPY'],
      methods: ['bank_transfer'],
      partnerAppliesFx: true,
      cryptoLicensed: false,
    }, 'JPY', 100_000);

    expect(result.mode).toBe('PARTNER_FX');
    expect(result.settlementCurrency).toBe('USD');
  });

  // A GBP payout to a GBP-capable partner is funded in GBP, not bridged
  // through USD — there is no reason to convert twice.
  it('funds a GBP payout directly in GBP', async () => {
    const result = await plan({
      settlementCurrencies: scrambled,
      payoutCurrencies: ['GBP'],
      methods: ['bank_transfer'],
      partnerAppliesFx: false,
      cryptoLicensed: false,
    }, 'GBP', 500);

    expect(result.mode).toBe('DIRECT_FIAT');
    expect(result.settlementCurrency).toBe('GBP');
  });
});
