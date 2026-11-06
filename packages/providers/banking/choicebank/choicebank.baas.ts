import type { IBaaSProvider, PaymentDestination, BaaSQuote, BaaSPayoutParams, BaaSPayoutResult, PayoutMethod } from '../../ports/baas.interface';
import { sendTransfer, type ChoiceBankCurrency, type ChoiceBankDestination } from './choicebank';

// Choice Bank handles bank transfers across Sub-Saharan Africa + CNY.
// KES bank transfers come here; KES mobile money goes to Daraja/MTN.
const CURRENCIES = ['NGN', 'GHS', 'ZAR', 'KES', 'TZS', 'UGX', 'RWF', 'XOF', 'XAF', 'CNY'];

const FEE_USD: Record<string, number> = {
  NGN: 0.05,  GHS: 0.06,  ZAR: 0.08,  KES: 0.07,
  TZS: 0.05,  UGX: 0.04,  RWF: 0.04,  XOF: 0.06,
  XAF: 0.06,  CNY: 0.10,
};

export class ChoiceBankBaaSProvider implements IBaaSProvider {
  readonly id   = 'choicebank';
  readonly name = 'Choice Bank (Africa + CNY)';
  readonly supportedCurrencies = CURRENCIES;
  readonly atomicJit = false;

  // Bank, not a VASP — funded in USD, applies its own FX, delivers local
  // currency into a bank account.
  readonly capability = {
    settlementCurrencies: ['USD'],
    payoutCurrencies:     CURRENCIES,
    methods:              ['bank_transfer'] as PayoutMethod[],
    partnerAppliesFx:     true,
    cryptoLicensed:       false,
    prefundedFloat:       false,
  };

  canHandle(currency: string, destination: PaymentDestination): boolean {
    if (!CURRENCIES.includes(currency.toUpperCase())) return false;
    // Mobile money for this currency goes to Daraja or MTN — not ChoiceBank
    if (destination.method === 'mobile_money') return false;
    // Must have bank account details
    const hasAccount = Boolean(destination.bankAccountNumber ?? destination.accountNumber);
    const hasBank    = Boolean(destination.bankCode);
    return hasAccount && hasBank;
  }

  async getQuote(currency: string, amount: number, _destination: PaymentDestination): Promise<BaaSQuote> {
    const curr = currency.toUpperCase();
    return {
      providerId:       this.id,
      currency:         curr,
      amount,
      fee:              FEE_USD[curr] ?? 0.07,
      feePercent:       0,
      estimatedMinutes: curr === 'CNY' ? 60 : 15,
      validUntil:       Date.now() + 60_000,
    };
  }

  async sendPayout(params: BaaSPayoutParams): Promise<BaaSPayoutResult> {
    const { currency, amount, destination, reference, description } = params;
    const cbDest: ChoiceBankDestination = {
      accountNumber: destination.bankAccountNumber ?? destination.accountNumber ?? '',
      bankCode:      destination.bankCode ?? '',
      accountName:   destination.name,
      currency:      currency as ChoiceBankCurrency,
    };
    if (!cbDest.accountNumber || !cbDest.bankCode) {
      throw new Error(`ChoiceBank: accountNumber + bankCode required for ${currency} bank transfer`);
    }
    const result = await sendTransfer({ destination: cbDest, amount, reference, narration: description });
    return {
      providerId:       this.id,
      paymentId:        result.id,
      status:           result.status ?? 'PROCESSING',
      estimatedMinutes: currency.toUpperCase() === 'CNY' ? 60 : 15,
    };
  }
}
