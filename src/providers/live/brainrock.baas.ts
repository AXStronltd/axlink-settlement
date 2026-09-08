import type { IBaaSProvider, PaymentDestination, BaaSQuote, BaaSPayoutParams, BaaSPayoutResult, PayoutMethod } from '../../core/baas.interface';
import { sendPayment, resolvePaymentType } from './brainrock';

// Brainrock handles fiat bank transfers for developed-market currencies.
const CURRENCIES = ['GBP', 'USD', 'EUR', 'CAD', 'AED', 'CHF', 'SEK', 'DKK', 'NOK', 'SGD', 'HKD', 'AUD', 'NZD', 'JPY'];
const BRAINROCK_TREASURY = process.env.BRAINROCK_TREASURY_ACCOUNT_ID ?? '';

const FEE_PCT: Record<string, number> = {
  GBP: 0.001,  USD: 0.002,  EUR: 0.0015,  CAD: 0.002,
  AED: 0.003,  CHF: 0.002,  default: 0.003,
};
const SPEED_MINUTES: Record<string, number> = {
  GBP: 0,  EUR: 2,  USD: 60,  CAD: 120,
};

export class BrainrockBaaSProvider implements IBaaSProvider {
  readonly id   = 'brainrock';
  readonly name = 'Brainrock (EU / UK / USA / Canada)';
  readonly supportedCurrencies = CURRENCIES;
  readonly atomicJit = false;

  // Developed-market rails. USD/EUR/GBP are funded directly in the payout
  // currency (DIRECT_FIAT — no FX at the partner, the rate is ours and known);
  // everything else bridges through one of those three.
  readonly capability = {
    settlementCurrencies: ['USD', 'EUR', 'GBP'],
    payoutCurrencies:     CURRENCIES,
    methods:              ['bank_transfer'] as PayoutMethod[],
    partnerAppliesFx:     false,
    cryptoLicensed:       false,
    prefundedFloat:       false,
  };

  canHandle(currency: string, destination: PaymentDestination): boolean {
    if (!CURRENCIES.includes(currency.toUpperCase())) return false;
    // Mobile money not applicable for these currencies
    if (destination.method === 'mobile_money') return false;
    return true;
  }

  async getQuote(currency: string, amount: number, _destination: PaymentDestination): Promise<BaaSQuote> {
    const curr    = currency.toUpperCase();
    const feePct  = FEE_PCT[curr] ?? FEE_PCT['default'];
    return {
      providerId:       this.id,
      currency:         curr,
      amount,
      fee:              amount * feePct * 1.3,
      feePercent:       feePct,
      estimatedMinutes: SPEED_MINUTES[curr] ?? 30,
      validUntil:       Date.now() + 60_000,
    };
  }

  async sendPayout(params: BaaSPayoutParams): Promise<BaaSPayoutResult> {
    const { currency, amount, destination, reference, description } = params;
    if (!BRAINROCK_TREASURY) throw new Error('BRAINROCK_TREASURY_ACCOUNT_ID not configured');
    const result = await sendPayment({
      fromAccountId: BRAINROCK_TREASURY,
      destination: { ...destination, type: destination.type ?? resolvePaymentType(currency, destination) },
      amount, currency, reference, description,
    });
    return {
      providerId:       this.id,
      paymentId:        result.id,
      status:           'PROCESSING',
      estimatedMinutes: SPEED_MINUTES[currency.toUpperCase()] ?? 30,
    };
  }
}
