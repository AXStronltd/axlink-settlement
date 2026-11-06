import type { IBaaSProvider, PaymentDestination, BaaSQuote, BaaSPayoutParams, BaaSPayoutResult, PayoutMethod } from '../../ports/baas.interface';
import { sendB2C, normalizeMsisdn } from './daraja';

// Daraja handles M-Pesa mobile money for KES (Kenya), TZS (Tanzania), UGX (Uganda).
// KES bank transfers go to ChoiceBank — Daraja is mobile-money only.
const CURRENCIES = ['KES', 'TZS', 'UGX'];

const FEE_USD: Record<string, number> = {
  KES: 0.08,
  TZS: 0.05,
  UGX: 0.04,
};

export class DarajaBaaSProvider implements IBaaSProvider {
  readonly id   = 'daraja';
  readonly name = 'Daraja M-Pesa (Safaricom)';
  readonly supportedCurrencies = CURRENCIES;
  readonly atomicJit = false;  // B2BinPay funds AxLink Daraja account first, then B2C sends

  // Safaricom is an MNO with a mobile-money licence, not a VASP: it cannot
  // receive crypto. Funded in USD, it applies its own FX and delivers local
  // currency — the shape `atomicJit` could not express, which is why KES was
  // unreachable before.
  readonly capability = {
    settlementCurrencies: ['USD'],
    payoutCurrencies:     CURRENCIES,
    methods:              ['mobile_money'] as PayoutMethod[],
    countries:            ['KE', 'TZ', 'UG'],
    partnerAppliesFx:     true,
    cryptoLicensed:       false,
    // Set true once a float is funded and monitored — that is what makes the
    // recipient's experience real-time. Costs working capital per corridor.
    prefundedFloat:       false,
  };

  canHandle(currency: string, destination: PaymentDestination): boolean {
    if (!CURRENCIES.includes(currency.toUpperCase())) return false;
    if (!destination.mobileNumber) return false;
    // Explicit method: if caller said bank_transfer, skip — Daraja is mobile only
    if (destination.method && destination.method !== 'mobile_money') return false;
    // mobileProvider filter: we handle mpesa and unspecified
    const mp = destination.mobileProvider;
    if (mp && mp !== 'mpesa' && mp !== 'momo') return false;
    return true;
  }

  async getQuote(currency: string, amount: number, _destination: PaymentDestination): Promise<BaaSQuote> {
    const curr = currency.toUpperCase();
    return {
      providerId:       this.id,
      currency:         curr,
      amount,
      fee:              FEE_USD[curr] ?? 0.10,
      feePercent:       0,
      estimatedMinutes: 1,
      validUntil:       Date.now() + 60_000,
    };
  }

  async sendPayout(params: BaaSPayoutParams): Promise<BaaSPayoutResult> {
    const { currency, amount, destination, reference, description } = params;
    if (!destination.mobileNumber) {
      throw new Error(`Daraja: mobileNumber required for ${currency} mobile money payout`);
    }
    const result = await sendB2C({
      amount,
      phoneNumber: normalizeMsisdn(destination.mobileNumber),
      reference,
      occasion: description,
    });
    return {
      providerId:       this.id,
      paymentId:        result.ConversationID,
      status:           'PROCESSING',
      estimatedMinutes: 1,
    };
  }
}
