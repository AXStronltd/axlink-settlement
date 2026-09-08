/**
 * A configurable provider that talks to nothing.
 *
 * The orchestrator's claim is that it routes on declared capability and never
 * on provider identity. That claim cannot be tested with the real providers:
 * they need credentials, they have fixed capabilities, and a test that asserts
 * "Daraja won" proves only that Daraja exists.
 *
 * This provider is built from its capability declaration alone. A test states
 * what a partner can do, and the orchestrator either routes to it or does not.
 * If routing ever grows a branch on provider id, these tests fail — because
 * nothing here is named after a real partner.
 *
 * Not registered by the bootstrap. Tests construct and register it themselves.
 */

import type {
  IBaaSProvider,
  PaymentDestination,
  BaaSQuote,
  BaaSPayoutParams,
  BaaSPayoutResult,
  PayoutMethod,
} from '../../core/baas.interface';
import type { ProviderCapability } from '../../core/provider/capability';
import type { AdapterHealth } from '../../core/provider/health';

export interface MockProviderConfig {
  id: string;
  name?: string;
  capability: ProviderCapability;

  /** Flat fee this provider quotes, in USD. Lower wins a two-horse race. */
  feeUsd?: number;
  estimatedMinutes?: number;

  /** What healthCheck() reports. Omit and the provider declares none at all. */
  health?: AdapterHealth;

  /** Fail every payout — for the provider-API-error case. */
  failPayout?: { message: string; code?: string };
  /** Never return a quote — for the timeout case. */
  hangQuote?: boolean;
  /** Throw on quote — distinct from hanging. */
  failQuote?: string;

  /** Destination fields required before canHandle() accepts, e.g. ['mobileNumber']. */
  requires?: Array<keyof PaymentDestination>;
}

export class MockProvider implements IBaaSProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedCurrencies: string[];
  readonly capability: ProviderCapability;
  readonly atomicJit = false;

  /** Every payout this provider was asked to make, for assertions. */
  readonly payouts: BaaSPayoutParams[] = [];
  /** Every quote request, so a test can prove a provider was never consulted. */
  readonly quoteRequests: Array<{ currency: string; amount: number }> = [];

  constructor(private readonly config: MockProviderConfig) {
    this.id = config.id;
    this.name = config.name ?? `Mock ${config.id}`;
    this.capability = config.capability;
    this.supportedCurrencies = config.capability.payoutCurrencies;
  }

  canHandle(currency: string, destination: PaymentDestination): boolean {
    if (!this.capability.payoutCurrencies.map(c => c.toUpperCase()).includes(currency.toUpperCase())) {
      return false;
    }
    if (destination.method && !this.capability.methods.includes(destination.method as PayoutMethod)) {
      return false;
    }
    // Same shape as a real adapter: the provider owns the question of whether
    // the destination carries the fields its API needs.
    return (this.config.requires ?? []).every(field => Boolean(destination[field]));
  }

  async getQuote(currency: string, amount: number): Promise<BaaSQuote> {
    this.quoteRequests.push({ currency, amount });

    if (this.config.failQuote) throw new Error(this.config.failQuote);
    // Outlives the registry's 4s quote timeout without a timer the test has to
    // wait on: the race rejects, this promise is simply abandoned.
    if (this.config.hangQuote) await new Promise(() => {});

    return {
      providerId: this.id,
      currency: currency.toUpperCase(),
      amount,
      fee: this.config.feeUsd ?? 1,
      feePercent: 0,
      estimatedMinutes: this.config.estimatedMinutes ?? 5,
      validUntil: Date.now() + 60_000,
    };
  }

  async sendPayout(params: BaaSPayoutParams): Promise<BaaSPayoutResult> {
    this.payouts.push(params);

    if (this.config.failPayout) {
      throw Object.assign(new Error(this.config.failPayout.message), {
        code: this.config.failPayout.code ?? 'PROVIDER_ERROR',
      });
    }

    return {
      providerId: this.id,
      paymentId: `${this.id}_${this.payouts.length}`,
      status: 'PROCESSING',
      estimatedMinutes: this.config.estimatedMinutes ?? 5,
    };
  }

  // Only present when the test configures one. A provider that declares no
  // health check must report UNCONFIGURED rather than be assumed healthy, and
  // that distinction is only testable if this can genuinely be absent.
  healthCheck = undefined as unknown as (() => Promise<AdapterHealth>) | undefined;

  /** Attach a health probe after construction, so absence is also testable. */
  withHealth(health: AdapterHealth): this {
    this.healthCheck = async () => health;
    return this;
  }
}

/** A KES mobile-money payout partner — the shape most tests want. */
export function mockKesProvider(id: string, overrides: Partial<MockProviderConfig> = {}): MockProvider {
  return new MockProvider({
    id,
    capability: {
      settlementCurrencies: ['USD'],
      payoutCurrencies: ['KES'],
      methods: ['mobile_money'],
      countries: ['KE'],
      operations: ['PAYOUT'],
      partnerAppliesFx: true,
      cryptoLicensed: false,
      prefundedFloat: false,
    },
    requires: ['mobileNumber'],
    ...overrides,
  });
}
