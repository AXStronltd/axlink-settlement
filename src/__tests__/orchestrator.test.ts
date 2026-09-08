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
} from '../core/baas-registry.service';
import { resetAllBreakers } from '../core/provider/circuit-breaker';
import { MockProvider, mockKesProvider } from '../providers/mock/mock.baas';
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
