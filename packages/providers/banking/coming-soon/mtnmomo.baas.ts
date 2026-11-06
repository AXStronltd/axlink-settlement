/**
 * MTN MoMo BaaS Provider
 *
 * MTN Mobile Money covers 17+ African markets — wherever Safaricom M-Pesa doesn't.
 * MTN provides a unified REST API (Disbursements API) across all its markets.
 *
 * Coverage (mobile money currencies):
 *   GHS — Ghana    NGN — Nigeria    UGX — Uganda     RWF — Rwanda
 *   ZMW — Zambia   XOF — Côte d'Ivoire / Senegal / Mali / Burkina Faso
 *   XAF — Cameroon / DRC / Republic of Congo
 *   SZL — Eswatini   MWK — Malawi
 *
 * To enable: set MTNMOMO_PRIMARY_KEY, MTNMOMO_API_USER, MTNMOMO_API_KEY in .env
 * Uncomment in baas-bootstrap.ts.
 *
 * MTN MoMo API: https://momodeveloper.mtn.com/api-documentation/disbursements/
 */

import type { IBaaSProvider, PaymentDestination, BaaSQuote, BaaSPayoutParams, BaaSPayoutResult } from '../../ports/baas.interface';
import { randomUUID } from 'crypto';

// Currencies MTN MoMo can disburse to
const MTN_CURRENCIES = ['GHS', 'NGN', 'UGX', 'RWF', 'ZMW', 'XOF', 'XAF', 'SZL', 'MWK', 'BIF', 'GNF', 'LRD'];

// Country codes for each currency (MTN API requires ISO country in headers)
const CURRENCY_COUNTRY: Record<string, string> = {
  GHS: 'GH',  NGN: 'NG',  UGX: 'UG',  RWF: 'RW',
  ZMW: 'ZM',  XOF: 'SN',  XAF: 'CM',  SZL: 'SZ',
  MWK: 'MW',  BIF: 'BI',  GNF: 'GN',  LRD: 'LR',
};

const FEE_USD: Record<string, number> = {
  GHS: 0.05,  NGN: 0.04,  UGX: 0.04,  RWF: 0.03,
  ZMW: 0.05,  XOF: 0.06,  XAF: 0.06,  default: 0.06,
};

// ── MTN MoMo API types ────────────────────────────────────────────────────────

interface MoMoTransferRequest {
  amount:           string;
  currency:         string;
  externalId:       string;
  payee:            { partyIdType: 'MSISDN'; partyId: string };
  payerMessage:     string;
  payeeNote:        string;
}

interface MoMoTransferStatus {
  amount:       string;
  currency:     string;
  externalId:   string;
  payee:        { partyIdType: string; partyId: string };
  payerMessage: string;
  payeeNote:    string;
  status:       'PENDING' | 'SUCCESSFUL' | 'FAILED';
  reason?:      string;
}

// ── Auth — MTN uses OAuth2 bearer tokens ─────────────────────────────────────

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getMoMoToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 10_000) {
    return _cachedToken.token;
  }

  const apiUser = process.env.MTNMOMO_API_USER;
  const apiKey  = process.env.MTNMOMO_API_KEY;
  const subKey  = process.env.MTNMOMO_PRIMARY_KEY;
  const baseUrl = process.env.MTNMOMO_API_URL ?? 'https://proxy.momoapi.mtn.com';

  if (!apiUser || !apiKey || !subKey) {
    throw new Error('MTN MoMo credentials not configured. Set MTNMOMO_PRIMARY_KEY, MTNMOMO_API_USER, MTNMOMO_API_KEY');
  }

  const credentials = Buffer.from(`${apiUser}:${apiKey}`).toString('base64');
  const res = await fetch(`${baseUrl}/disbursement/token/`, {
    method: 'POST',
    headers: {
      'Authorization':             `Basic ${credentials}`,
      'Ocp-Apim-Subscription-Key': subKey,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`MTN MoMo token fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };

  _cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in * 1000) };
  return _cachedToken.token;
}

async function momoRequest<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<{ data: T; referenceId?: string }> {
  const baseUrl = process.env.MTNMOMO_API_URL ?? 'https://proxy.momoapi.mtn.com';
  const subKey  = process.env.MTNMOMO_PRIMARY_KEY ?? '';
  const token   = await getMoMoToken();
  const referenceId = randomUUID();

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Authorization':             `Bearer ${token}`,
      'Ocp-Apim-Subscription-Key': subKey,
      'Content-Type':              'application/json',
      'X-Reference-Id':            referenceId,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok && res.status !== 202) {
    throw new Error(`MTN MoMo ${method} ${path} → ${res.status}: ${await res.text()}`);
  }

  const data = res.status === 202 ? {} as T : await res.json() as T;
  return { data, referenceId };
}

// ── Provider implementation ───────────────────────────────────────────────────

export class MtnMomoBaaSProvider implements IBaaSProvider {
  readonly id   = 'mtnmomo';
  readonly name = 'MTN MoMo (Africa)';
  readonly supportedCurrencies = MTN_CURRENCIES;
  readonly atomicJit = false;

  canHandle(currency: string, destination: PaymentDestination): boolean {
    if (!MTN_CURRENCIES.includes(currency.toUpperCase())) return false;
    if (!destination.mobileNumber) return false;
    // Explicit method must be mobile_money (or unspecified)
    if (destination.method && destination.method !== 'mobile_money') return false;
    // mobileProvider filter — we handle mtn, momo, or unspecified
    const mp = destination.mobileProvider;
    if (mp && mp !== 'mtn' && mp !== 'momo') return false;
    return true;
  }

  async getQuote(currency: string, amount: number, _destination: PaymentDestination): Promise<BaaSQuote> {
    const curr = currency.toUpperCase();
    return {
      providerId:       this.id,
      currency:         curr,
      amount,
      fee:              FEE_USD[curr] ?? FEE_USD['default'],
      feePercent:       0,
      estimatedMinutes: 2,
      validUntil:       Date.now() + 60_000,
    };
  }

  async sendPayout(params: BaaSPayoutParams): Promise<BaaSPayoutResult> {
    const { currency, amount, destination, reference } = params;
    const curr = currency.toUpperCase();

    if (!destination.mobileNumber) {
      throw new Error(`MTN MoMo: mobileNumber required for ${curr} disbursement`);
    }

    const countryCode = destination.countryCode ?? CURRENCY_COUNTRY[curr] ?? 'GH';

    const body: MoMoTransferRequest = {
      amount:       amount.toString(),
      currency:     curr,
      externalId:   reference,
      payee:        { partyIdType: 'MSISDN', partyId: destination.mobileNumber.replace(/\D/g, '') },
      payerMessage: `AxLink transfer ${reference}`,
      payeeNote:    `Sent via AxLink`,
    };

    const { referenceId } = await momoRequest<void>(
      'POST',
      '/disbursement/v1_0/transfer',
      body,
      { 'X-Target-Environment': process.env.MTNMOMO_ENV ?? 'mtncameroon' },
    );

    return {
      providerId:       this.id,
      paymentId:        referenceId ?? reference,
      status:           'PROCESSING',
      estimatedMinutes: 2,
    };
  }
}
