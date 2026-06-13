/**
 * Thunes BaaS Provider
 *
 * Thunes is a global payout network covering mobile money, bank transfers,
 * and cash pickup in 100+ countries — corridors not covered by Daraja or ChoiceBank.
 *
 * AxLink uses Thunes as an overflow/extension layer:
 *   - West Africa CFA zone: XOF (Senegal, Côte d'Ivoire, Mali), XAF (Cameroon, DRC)
 *   - East Africa: RWF (Rwanda), ETB (Ethiopia), MZN (Mozambique)
 *   - South Asia: INR (India), PKR (Pakistan), BDT (Bangladesh), LKR (Sri Lanka)
 *   - Southeast Asia: PHP (Philippines), VND (Vietnam), THB (Thailand), IDR (Indonesia)
 *   - Latin America: MXN (Mexico), BRL (Brazil), COP (Colombia), PEN (Peru)
 *
 * To enable: set THUNES_CLIENT_ID and THUNES_API_KEY in .env, uncomment the
 * provider in baas-bootstrap.ts.
 *
 * Thunes API reference: https://docs.thunes.com/api-reference
 */

import type { IBaaSProvider, PaymentDestination, BaaSQuote, BaaSPayoutParams, BaaSPayoutResult } from '../../core/baas.interface';

// ── Thunes API types ──────────────────────────────────────────────────────────

interface ThunesQuoteRequest {
  source:        { currency: string; country: string };
  destination:   { currency: string; country: string };
  source_amount: number;
}

interface ThunesQuoteResponse {
  id:                  string;
  source:              { currency: string; amount: number };
  destination:         { currency: string; amount: number };
  fee:                 { total: number; currency: string };
  expiration:          string;
  wholesale_fx_rate:   number;
  mode:                'SOURCE_AMOUNT' | 'DESTINATION_AMOUNT';
}

interface ThunesTransactionRequest {
  quote_id:             string;
  external_id:          string;    // AxLink tracking ID
  payer:                { lastname: string; firstname: string };
  beneficiary: {
    lastname:           string;
    firstname:          string;
    address?:           { line1?: string; city?: string; country_iso_code?: string };
    // Mobile money
    msisdn?:            string;
    // Bank
    account_number?:    string;
    bank_code?:         string;
    iban?:              string;
    bic?:               string;
  };
  purpose_of_remittance?: string;
  additional_information?: string;
}

interface ThunesTransactionResponse {
  id:             number;
  status:         'CREATED' | 'CONFIRMED' | 'AUTHORIZED' | 'SETTLED' | 'CANCELLED';
  external_id:    string;
  creation_date:  string;
  expiration_date: string;
  source:         { currency: string; amount: number };
  destination:    { currency: string; amount: number };
  fee:            { total: number; currency: string };
  wholesale_fx_rate: number;
}

// ── Supported currencies and their Thunes service type ───────────────────────

// Map: currencyCode → { country, serviceType }
const THUNES_CURRENCIES: Record<string, { country: string; serviceType: 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'CASH_PICKUP' }> = {
  // West Africa
  XOF: { country: 'SN', serviceType: 'MOBILE_MONEY' },   // CFA — Senegal default
  XAF: { country: 'CM', serviceType: 'MOBILE_MONEY' },   // CFA — Cameroon default
  GNF: { country: 'GN', serviceType: 'MOBILE_MONEY' },   // Guinea
  SLL: { country: 'SL', serviceType: 'MOBILE_MONEY' },   // Sierra Leone
  // East Africa
  RWF: { country: 'RW', serviceType: 'MOBILE_MONEY' },
  ETB: { country: 'ET', serviceType: 'BANK_TRANSFER' },
  MZN: { country: 'MZ', serviceType: 'MOBILE_MONEY' },
  // South Asia
  INR: { country: 'IN', serviceType: 'BANK_TRANSFER' },
  PKR: { country: 'PK', serviceType: 'BANK_TRANSFER' },
  BDT: { country: 'BD', serviceType: 'BANK_TRANSFER' },
  LKR: { country: 'LK', serviceType: 'BANK_TRANSFER' },
  // Southeast Asia
  PHP: { country: 'PH', serviceType: 'BANK_TRANSFER' },
  VND: { country: 'VN', serviceType: 'BANK_TRANSFER' },
  THB: { country: 'TH', serviceType: 'BANK_TRANSFER' },
  IDR: { country: 'ID', serviceType: 'BANK_TRANSFER' },
  MYR: { country: 'MY', serviceType: 'BANK_TRANSFER' },
  // Latin America
  MXN: { country: 'MX', serviceType: 'BANK_TRANSFER' },
  BRL: { country: 'BR', serviceType: 'BANK_TRANSFER' },
  COP: { country: 'CO', serviceType: 'BANK_TRANSFER' },
  PEN: { country: 'PE', serviceType: 'BANK_TRANSFER' },
  // China
  CNY: { country: 'CN', serviceType: 'BANK_TRANSFER' },
};

// ── HTTP client ───────────────────────────────────────────────────────────────

async function thunesRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const clientId = process.env.THUNES_CLIENT_ID;
  const apiKey   = process.env.THUNES_API_KEY;
  const baseUrl  = process.env.THUNES_API_URL ?? 'https://api.thunes.com';

  if (!clientId || !apiKey) {
    throw new Error('THUNES_CLIENT_ID and THUNES_API_KEY must be set to use the Thunes provider');
  }

  const credentials = Buffer.from(`${clientId}:${apiKey}`).toString('base64');
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Thunes API ${method} ${path} → ${res.status}: ${err}`);
  }

  return res.json() as Promise<T>;
}

// ── Provider implementation ───────────────────────────────────────────────────

export class ThunesBaaSProvider implements IBaaSProvider {
  readonly id   = 'thunes';
  readonly name = 'Thunes Global Payout Network';
  readonly supportedCurrencies = Object.keys(THUNES_CURRENCIES);
  readonly atomicJit = true;  // Thunes handles USDT→fiat + delivery in one call

  canHandle(currency: string, destination: PaymentDestination): boolean {
    const meta = THUNES_CURRENCIES[currency.toUpperCase()];
    if (!meta) return false;
    if (meta.serviceType === 'MOBILE_MONEY') {
      return Boolean(destination.mobileNumber);
    }
    // Bank transfer
    return Boolean(destination.accountNumber ?? destination.bankAccountNumber ?? destination.iban);
  }

  async getQuote(currency: string, amount: number, destination: PaymentDestination): Promise<BaaSQuote> {
    const curr = currency.toUpperCase();
    const meta = THUNES_CURRENCIES[curr];
    if (!meta) throw new Error(`Thunes does not support ${curr}`);

    const country = destination.countryCode ?? meta.country;

    const quote = await thunesRequest<ThunesQuoteResponse>('POST', '/v2/money-transfer/quotations', {
      source:        { currency: 'USD', country: 'US' },   // AxLink settles in USD
      destination:   { currency: curr, country: country },
      source_amount: amount,
    } satisfies ThunesQuoteRequest);

    return {
      providerId:       this.id,
      currency:         curr,
      amount:           quote.destination.amount,
      fee:              quote.fee.total,
      feePercent:       quote.fee.total / amount,
      estimatedMinutes: meta.serviceType === 'MOBILE_MONEY' ? 5 : 60,
      validUntil:       new Date(quote.expiration).getTime(),
    };
  }

  async sendPayout(params: BaaSPayoutParams): Promise<BaaSPayoutResult> {
    const { currency, amount, destination, reference } = params;
    const curr = currency.toUpperCase();
    const meta = THUNES_CURRENCIES[curr];
    if (!meta) throw new Error(`Thunes does not support ${curr}`);

    const country = destination.countryCode ?? meta.country;

    // 1. Get a quote
    const quote = await thunesRequest<ThunesQuoteResponse>('POST', '/v2/money-transfer/quotations', {
      source:        { currency: 'USD', country: 'US' },
      destination:   { currency: curr, country: country },
      source_amount: amount,
    } satisfies ThunesQuoteRequest);

    // 2. Create transaction
    const nameParts = (destination.name ?? 'Unknown User').split(' ');
    const txReq: ThunesTransactionRequest = {
      quote_id:    quote.id,
      external_id: reference,
      payer: {
        lastname:  'AxLink',
        firstname: 'AxLink Network',
      },
      beneficiary: {
        lastname:       nameParts.slice(1).join(' ') || nameParts[0],
        firstname:      nameParts[0],
        ...(destination.mobileNumber    ? { msisdn:         destination.mobileNumber } : {}),
        ...(destination.accountNumber   ? { account_number: destination.accountNumber } : {}),
        ...(destination.bankAccountNumber ? { account_number: destination.bankAccountNumber } : {}),
        ...(destination.bankCode        ? { bank_code:      destination.bankCode } : {}),
        ...(destination.iban            ? { iban:           destination.iban } : {}),
        ...(destination.bic             ? { bic:            destination.bic } : {}),
        address: { country_iso_code: country },
      },
      purpose_of_remittance: 'FAMILY_SUPPORT',
      additional_information: `AxLink ${reference}`,
    };

    const tx = await thunesRequest<ThunesTransactionResponse>(
      'POST', '/v2/money-transfer/transactions', txReq,
    );

    // 3. Confirm (Thunes requires a second call to move from CREATED → CONFIRMED)
    await thunesRequest('POST', `/v2/money-transfer/transactions/${tx.id}/confirm`, {});

    return {
      providerId:       this.id,
      paymentId:        String(tx.id),
      status:           'PROCESSING',
      estimatedMinutes: meta.serviceType === 'MOBILE_MONEY' ? 5 : 60,
    };
  }
}
