/**
 * Orange Money BaaS Provider
 *
 * Orange Money is dominant in Francophone West Africa.
 * Uses Orange Money API (Transfert d'argent) for B2C disbursements.
 *
 * Coverage:
 *   XOF — Senegal, Côte d'Ivoire, Mali, Burkina Faso, Niger, Guinea-Bissau
 *   XAF — Cameroon
 *   GNF — Guinea Conakry
 *   MDG — Madagascar (Malagasy Ariary — via Orange Madagascar)
 *
 * API: https://developer.orange.com/apis/om-webpay-prod/getting-started
 * Enable: set ORANGE_MONEY_CLIENT_ID, ORANGE_MONEY_CLIENT_SECRET in .env
 * Uncomment in baas-bootstrap.ts.
 */

import type { IBaaSProvider, PaymentDestination, BaaSQuote, BaaSPayoutParams, BaaSPayoutResult } from '../../ports/baas.interface';

const ORANGE_CURRENCIES = ['XOF', 'XAF', 'GNF', 'MDG'];

const FEE_USD: Record<string, number> = {
  XOF: 0.06,  XAF: 0.06,  GNF: 0.04,  MDG: 0.04,
};

// Orange API country codes
const CURRENCY_COUNTRY: Record<string, string> = {
  XOF: 'SN',   // Senegal default for XOF
  XAF: 'CM',   // Cameroon default for XAF
  GNF: 'GN',
  MDG: 'MG',
};

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getOrangeToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 10_000) return _cachedToken.token;

  const clientId     = process.env.ORANGE_MONEY_CLIENT_ID;
  const clientSecret = process.env.ORANGE_MONEY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Orange Money credentials not set (ORANGE_MONEY_CLIENT_ID, ORANGE_MONEY_CLIENT_SECRET)');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://api.orange.com/oauth/v3/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Orange token failed: ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  _cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in * 1000) };
  return _cachedToken.token;
}

export class OrangeMoneyBaaSProvider implements IBaaSProvider {
  readonly id   = 'orange';
  readonly name = 'Orange Money (West/Central Africa)';
  readonly supportedCurrencies = ORANGE_CURRENCIES;
  readonly atomicJit = false;

  canHandle(currency: string, destination: PaymentDestination): boolean {
    if (!ORANGE_CURRENCIES.includes(currency.toUpperCase())) return false;
    if (!destination.mobileNumber) return false;
    if (destination.method && destination.method !== 'mobile_money') return false;
    const mp = destination.mobileProvider;
    if (mp && mp !== 'orange' && mp !== 'momo') return false;
    return true;
  }

  async getQuote(currency: string, amount: number, _destination: PaymentDestination): Promise<BaaSQuote> {
    const curr = currency.toUpperCase();
    return {
      providerId:       this.id,
      currency:         curr,
      amount,
      fee:              FEE_USD[curr] ?? 0.06,
      feePercent:       0,
      estimatedMinutes: 3,
      validUntil:       Date.now() + 60_000,
    };
  }

  async sendPayout(params: BaaSPayoutParams): Promise<BaaSPayoutResult> {
    const { currency, amount, destination, reference } = params;
    const curr = currency.toUpperCase();

    if (!destination.mobileNumber) {
      throw new Error(`Orange Money: mobileNumber required for ${curr}`);
    }

    const country  = destination.countryCode ?? CURRENCY_COUNTRY[curr] ?? 'SN';
    const token    = await getOrangeToken();
    const baseUrl  = `https://api.orange.com/orange-money-webpay/${country.toLowerCase()}/v1`;

    const res = await fetch(`${baseUrl}/cashin`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        merchant_key:       process.env.ORANGE_MONEY_MERCHANT_KEY ?? '',
        currency:           curr,
        order_id:           reference,
        amount:             amount.toString(),
        return_url:         `${process.env.API_BASE_URL}/webhooks/orange/result`,
        cancel_url:         `${process.env.API_BASE_URL}/webhooks/orange/cancel`,
        notif_url:          `${process.env.API_BASE_URL}/webhooks/orange/notify`,
        lang:               'fr',
        reference:          reference,
        customer_msisdn:    destination.mobileNumber,
        customer_firstname: destination.name.split(' ')[0],
        customer_lastname:  destination.name.split(' ').slice(1).join(' ') || destination.name,
        customer_email:     '',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`Orange Money cashin failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json() as { txnid: string; status: string };

    return {
      providerId:       this.id,
      paymentId:        data.txnid ?? reference,
      status:           'PROCESSING',
      estimatedMinutes: 3,
    };
  }
}
