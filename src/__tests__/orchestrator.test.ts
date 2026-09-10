import { describe, it, expect, beforeEach, vi } from 'vitest';

// The registry reaches the converter and custodian to fund a partner. None of
// that is under test here — routing is — so the funding leg is stubbed and the
// assertions are about which provider was chosen and why.
vi.mock('../providers/live/b2binpay', () => ({
  createPayout: vi.fn(async () => ({ id: 'b2b_stub', tracking_id: 'x', status: 2, amount: '0', fee_amount: '0' })),
  calculatePayoutFee: vi.fn(async () => ({ is_internal: false, fee: { low: '0', medium: '0', high: '0' }, warning: null })),
  B2B_SETTLEMENT_CURRENCIES: new Set(['USD', 'EUR', 'GBP', 'USDT']),
}));
vi.mock('../providers/live/fireblocks', () => ({
  createTransfer: vi.fn(async () => ({ id: 'fb_stub' })),
}));
vi.mock('./../core/provider/attempt.service', async () => ({
  record: vi.fn(async () => undefined),
  timed: vi.fn(async (_meta: unknown, fn: () => Promise<unknown>) => fn()),
  providerHealth: vi.fn(async () => []),
  attemptsFor: vi.fn(async () => []),
}));

import {
  registerBaaSProvider,
  resetRegistryForTests,
  setProviderEnabled,
  getRegisteredProviders,
  deliverFiat,
  collectFunds,
  validateBeneficiary,
} from '../core/baas-registry.service';
import { resetAllBreakers } from '../core/provider/circuit-breaker';
import { MockProvider, mockKesProvider, mockKesCollector } from '../providers/mock/mock.baas';
import type { IBaaSProvider, PaymentDestination } from '../core/baas.interface';

/**
 * Register a provider and give it the float account the funding leg needs.
 *
 * The account resolves from the provider id by convention
 * (`<ID>_FLOAT_ACCOUNT`), which is what lets a new partner be added without
 * editing core — so a test provider configures itself the same way a real one
 * would, rather than special-casing around it.
 */
function register(p: IBaaSProvider): void {
  process.env[`${p.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FLOAT_ACCOUNT`] = `float_${p.id}`;
  registerBaaSProvider(p);
}

const KES_DEST: PaymentDestination = {
  name: 'Beneficiary',
  method: 'mobile_money',
  mobileNumber: '+254712345678',
  countryCode: 'KE',
};

const pay = (amount = 1000, destination: PaymentDestination = KES_DEST, currency = 'KES') =>
  deliverFiat({
    currency,
    amount,
    usdtAmount: amount / 129,
    destination,
    reference: `ref_${Math.random().toString(36).slice(2, 8)}`,
    description: 'test payout',
  });

beforeEach(() => {
  resetRegistryForTests();
  resetAllBreakers();
  process.env.DARAJA_B2C_FLOAT_ACCOUNT = 'sandbox_float';
});

// ── 9. Routing to a provider the core knows nothing about ────────────────────

describe('routing by capability alone', () => {
  it('routes to a provider the orchestrator has never heard of', async () => {
    const partner = mockKesProvider('some-partner-we-invented');
    register(partner);

    const result = await pay(1000);

    expect(result.provider).toBe('some-partner-we-invented');
    expect(partner.payouts).toHaveLength(1);
    expect(partner.payouts[0].amount).toBe(1000);
  });

  it('names the capabilities that matched, not just the winner', async () => {
    register(mockKesProvider('partner-a'));

    const { decision } = await pay(1000);

    expect(decision.selectedProviderId).toBe('partner-a');
    expect(decision.matched).toContain('currency:KES');
    expect(decision.matched).toContain('country:KE');
    expect(decision.matched).toContain('operation:PAYOUT');
    expect(decision.correlationId).toBeTruthy();
    expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ── 10. Switching, with no change to core ────────────────────────────────────

describe('provider switching', () => {
  it('picks the cheaper of two providers with identical capabilities', async () => {
    const a = mockKesProvider('provider-a', { feeUsd: 0.05 });
    const b = mockKesProvider('provider-b', { feeUsd: 0.50 });
    register(a);
    register(b);

    const result = await pay(1000);

    expect(result.provider).toBe('provider-a');
    expect(b.payouts).toHaveLength(0);
  });

  // The point of the exercise: the only thing that changes is a flag.
  it('falls to the second provider when the first is disabled', async () => {
    const a = mockKesProvider('provider-a', { feeUsd: 0.05 });
    const b = mockKesProvider('provider-b', { feeUsd: 0.50 });
    register(a);
    register(b);

    expect((await pay(1000)).provider).toBe('provider-a');

    setProviderEnabled('provider-a', false);
    const after = await pay(1000);

    expect(after.provider).toBe('provider-b');
    expect(after.decision.rejected.map(r => r.reason)).toContain('DISABLED');
    // A disabled provider is never consulted, not merely discarded late.
    expect(a.quoteRequests).toHaveLength(1);
  });

  it('explains why the runner-up lost', async () => {
    register(mockKesProvider('cheap', { feeUsd: 0.05 }));
    register(mockKesProvider('dear', { feeUsd: 0.50 }));

    const { decision } = await pay(1000);

    expect(decision.selectionBasis).toContain('cheapest');
    expect(decision.rejected.find(r => r.providerId === 'dear')?.detail).toContain('0.500');
  });
});

// ── 11. Failure modes, each returning a normalized error ─────────────────────

describe('failure modes', () => {
  it('unsupported currency', async () => {
    register(mockKesProvider('kes-only'));
    await expect(pay(1000, { ...KES_DEST, countryCode: 'NG' }, 'NGN'))
      .rejects.toMatchObject({ code: 'NO_PROVIDER_ROUTE' });
  });

  it('unsupported country', async () => {
    register(mockKesProvider('kenya-only'));

    await expect(pay(1000, { ...KES_DEST, countryCode: 'TZ' })).rejects.toMatchObject({
      code: 'NO_PROVIDER_ROUTE',
    });
  });

  it('amount above the declared limit', async () => {
    register(mockKesProvider('capped', {
      capability: {
        settlementCurrencies: ['USD'],
        payoutCurrencies: ['KES'],
        methods: ['mobile_money'],
        countries: ['KE'],
        operations: ['PAYOUT'],
        limits: { KES: { max: 5_000 } },
      },
    }));

    const err = await pay(10_000).catch(e => e);
    expect(err.code).toBe('NO_PROVIDER_ROUTE');
    expect(err.decision.rejected[0].reason).toBe('AMOUNT_ABOVE_MAX');
    expect(err.decision.rejected[0].detail).toContain('5000');
  });

  it('operation the provider does not serve', async () => {
    register(mockKesProvider('collector', {
      capability: {
        settlementCurrencies: ['USD'],
        payoutCurrencies: ['KES'],
        methods: ['mobile_money'],
        operations: ['COLLECTION'],   // takes money in; cannot pay out
      },
    }));

    const err = await pay(1000).catch(e => e);
    expect(err.code).toBe('NO_PROVIDER_ROUTE');
    expect(err.decision.rejected[0].reason).toBe('OPERATION_UNSUPPORTED');
  });

  it('no providers registered at all', async () => {
    await expect(pay(1000)).rejects.toMatchObject({ code: 'NO_PROVIDER_ROUTE' });
  });

  it('provider API error propagates with its code', async () => {
    register(mockKesProvider('breaks', {
      failPayout: { message: 'partner rejected the transfer', code: 'PARTNER_REJECTED' },
    }));

    await expect(pay(1000)).rejects.toMatchObject({ code: 'PARTNER_REJECTED' });
  });

  it('a provider that cannot quote is passed over, not fatal', async () => {
    register(mockKesProvider('silent', { failQuote: 'upstream 502' }));
    register(mockKesProvider('working', { feeUsd: 0.20 }));

    const result = await pay(1000);

    expect(result.provider).toBe('working');
    expect(result.decision.rejected.find(r => r.providerId === 'silent')?.reason).toBe('QUOTE_FAILED');
  });

  it('destination missing the field the provider requires', async () => {
    register(mockKesProvider('needs-msisdn'));

    const err = await pay(1000, { name: 'X', method: 'mobile_money', countryCode: 'KE' }).catch(e => e);
    expect(err.code).toBe('NO_PROVIDER_ROUTE');
    expect(err.decision.rejected[0].detail).toContain('destination fields');
  });
});

// ── Registration is where a broken provider should be caught ─────────────────

describe('registration', () => {
  it('refuses a provider that claims PAYOUT without implementing it', () => {
    const broken = new MockProvider({
      id: 'claims-too-much',
      capability: {
        settlementCurrencies: ['USD'],
        payoutCurrencies: ['KES'],
        methods: ['mobile_money'],
        operations: ['PAYOUT'],
      },
    });
    // Strip the method the capability promises.
    (broken as { sendPayout?: unknown }).sendPayout = undefined;

    expect(() => registerBaaSProvider(broken)).toThrow(/declares the PAYOUT operation/);
  });

  it('accepts a collection-only provider with no sendPayout', () => {
    const collector = new MockProvider({
      id: 'collector-only',
      capability: {
        settlementCurrencies: ['USD'],
        payoutCurrencies: ['KES'],
        methods: ['bank_transfer'],
        operations: ['COLLECTION'],
      },
    });
    (collector as { sendPayout?: unknown }).sendPayout = undefined;

    expect(() => registerBaaSProvider(collector)).not.toThrow();
    expect(getRegisteredProviders()[0].operations).toEqual(['COLLECTION']);
  });

  it('rejects a duplicate provider id', () => {
    register(mockKesProvider('same-id'));
    expect(() => registerBaaSProvider(mockKesProvider('same-id'))).toThrow(/already registered/);
  });
});

// ── Collection: money coming in, routed the same way ─────────────────────────

const collectRequest = (overrides: Record<string, unknown> = {}) => ({
  currency: 'KES',
  amount: 5_000,
  method: 'mobile_money' as const,
  customerRef: 'user_1',
  reference: `col_${Math.random().toString(36).slice(2, 8)}`,
  countryCode: 'KE',
  ...overrides,
});

describe('collection', () => {
  it('routes to a collection provider the core has never heard of', async () => {
    const partner = mockKesCollector('inbound-partner');
    register(partner);

    const result = await collectFunds(collectRequest());

    expect(result.providerId).toBe('inbound-partner');
    expect(result.decision.selectedProviderId).toBe('inbound-partner');
    expect(partner.collections).toHaveLength(1);
  });

  // A partner saying "created" is not a customer having paid. The ledger moves
  // on the webhook and the on-chain proof, never on this call returning.
  it('never reports money as received', async () => {
    register(mockKesCollector('inbound'));

    const result = await collectFunds(collectRequest());

    expect(result.status).toBe('AWAITING_PAYMENT');
  });

  it('returns instructions the caller must handle by kind', async () => {
    register(mockKesCollector('push-partner'));

    const result = await collectFunds(collectRequest());

    expect(result.instructions.kind).toBe('push');
    if (result.instructions.kind === 'push') {
      expect(result.instructions.sentTo).toBe('+254712345678');
    }
  });

  // A payout partner must never be handed a collection, however well its
  // currency and country match.
  it('will not route a collection to a payout-only provider', async () => {
    const payoutOnly = mockKesProvider('payout-only');
    register(payoutOnly);

    const err = await collectFunds(collectRequest()).catch(e => e);

    expect(err.code).toBe('NO_PROVIDER_ROUTE');
    expect(err.decision.rejected[0].reason).toBe('OPERATION_UNSUPPORTED');
    expect(payoutOnly.collections).toHaveLength(0);
  });

  it('fails over to a second collector when the first is disabled', async () => {
    register(mockKesCollector('collector-a'));
    register(mockKesCollector('collector-b'));

    expect((await collectFunds(collectRequest())).providerId).toBe('collector-a');

    setProviderEnabled('collector-a', false);
    const after = await collectFunds(collectRequest());

    expect(after.providerId).toBe('collector-b');
    expect(after.decision.rejected.map(r => r.reason)).toContain('DISABLED');
  });

  // A virtual IBAN accepts whatever the customer sends, so an absent amount
  // must not be read as zero and rejected by a minimum.
  it('accepts a collection with no fixed amount', async () => {
    register(mockKesCollector('standing-instrument', {
      capability: {
        settlementCurrencies: ['USD'],
        payoutCurrencies: ['KES'],
        methods: ['mobile_money'],
        operations: ['COLLECTION'],
        limits: { KES: { min: 100 } },
      },
      collection: { kind: 'bank_account', accountNumber: 'VA-1', reference: 'ref' },
    }));

    const result = await collectFunds(collectRequest({ amount: undefined }));

    expect(result.providerId).toBe('standing-instrument');
  });

  it('registration refuses a provider claiming COLLECTION without collect()', () => {
    const broken = new MockProvider({
      id: 'claims-collection',
      capability: {
        settlementCurrencies: ['USD'],
        payoutCurrencies: ['KES'],
        methods: ['mobile_money'],
        operations: ['COLLECTION'],
      },
    });
    (broken as { collect?: unknown }).collect = undefined;

    expect(() => registerBaaSProvider(broken)).toThrow(/declares the COLLECTION operation/);
  });

  it('a partner error surfaces with its code', async () => {
    register(mockKesCollector('failing', {
      failCollect: { message: 'partner declined', code: 'COLLECTION_REFUSED' },
    }));

    await expect(collectFunds(collectRequest())).rejects.toMatchObject({ code: 'COLLECTION_REFUSED' });
  });
});

// ── Beneficiary validation: the check before money moves ─────────────────────

describe('beneficiary validation', () => {
  it('returns the name the partner holds for the account', async () => {
    register(mockKesProvider('verifier', {
      beneficiary: { verified: true, accountName: 'Supplier Limited' },
    }));

    const verdict = await validateBeneficiary('KES', KES_DEST);

    expect(verdict.verified).toBe(true);
    expect(verdict.accountName).toBe('Supplier Limited');
    expect(verdict.providerId).toBe('verifier');
  });

  it('reports a refusal with the partner reason', async () => {
    register(mockKesProvider('strict', {
      beneficiary: { verified: false, reason: 'account closed' },
    }));

    const verdict = await validateBeneficiary('KES', KES_DEST);

    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBe('account closed');
  });

  // The case the whole design turns on: no capability is not a pass.
  it('does not report verified when no provider can validate', async () => {
    register(mockKesProvider('cannot-validate'));   // no beneficiary configured

    const verdict = await validateBeneficiary('KES', KES_DEST);

    expect(verdict.verified).toBe(false);
    expect(verdict.providerId).toBeNull();
    expect(verdict.reason).toMatch(/No provider able to validate/);
  });

  // A partner that errored has told us nothing about the account. Reporting
  // that as verified would be the most expensive lie available here.
  it('does not report verified when the partner errors', async () => {
    register(mockKesProvider('flaky', { beneficiary: { throws: 'upstream 503' } }));

    const verdict = await validateBeneficiary('KES', KES_DEST);

    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('503');
    expect(verdict.providerId).toBe('flaky');
  });

  it('will not validate through a provider that cannot serve the rail', async () => {
    register(mockKesProvider('kes-only', {
      beneficiary: { verified: true, accountName: 'Wrong Rail' },
    }));

    const verdict = await validateBeneficiary('NGN', { ...KES_DEST, countryCode: 'NG' });

    expect(verdict.verified).toBe(false);
    expect(verdict.providerId).toBeNull();
  });
});

// ── EVC: the Somali rail is declarable ───────────────────────────────────────

describe('EVC', () => {
  it('routes a Somali mobile-money payout', async () => {
    const gib = mockKesProvider('somalia-partner', {
      capability: {
        settlementCurrencies: ['USD'],
        payoutCurrencies: ['USD'],       // Somalia is a USD economy
        methods: ['mobile_money'],
        countries: ['SO'],
        operations: ['PAYOUT'],
        partnerAppliesFx: false,          // USD in, USD out — nobody converts
      },
    });
    register(gib);

    const result = await pay(100, {
      name: 'Beneficiary',
      method: 'mobile_money',
      mobileProvider: 'evc',
      mobileNumber: '+252615001001',
      countryCode: 'SO',
    }, 'USD');

    expect(result.provider).toBe('somalia-partner');
    expect(gib.payouts[0].destination.mobileProvider).toBe('evc');
  });
});
