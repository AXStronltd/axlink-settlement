import crypto from 'crypto';

// ── Brainrock BaaS — Fiat banking layer ──────────────────────────────────────
// Provides per-user virtual IBANs and outbound fiat payments.
// Compatible pattern: swap BASE_URL + field names for Square, Railsr, ClearBank.
//
// Inbound:  User bank → user's virtual IBAN → Brainrock webhook → FinCruse
// Outbound: FinCruse treasury account → user's bank / M-Pesa / SEPA

const BASE_URL = process.env.BRAINROCK_SANDBOX === 'true'
  ? 'https://sandbox.api.brainrock.io/v1'
  : 'https://api.brainrock.io/v1';

// ── Types ────────────────────────────────────────────────────────────────────

export interface VirtualAccount {
  id: string;       // store as User.brainrockAccountId
  iban: string;     // show to user as their deposit IBAN
  bic: string;
  currency: string;
  status: string;
}

export interface OutboundPayment {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  amount: number;
  currency: string;
  reference: string;
  failureReason?: string;
}

export type PaymentType =
  | 'faster_payments'   // UK — sort code + account number, near-instant
  | 'sepa'              // EU — IBAN + BIC, same-day
  | 'swift'             // International — IBAN + BIC + SWIFT
  | 'mpesa'             // Kenya/Tanzania/Uganda — mobile number
  | 'bank_transfer'     // Generic — bank code + account
  | 'rtgs';             // High-value same-day (NGN, KES large amounts)

export interface PaymentDestination {
  name: string;
  type: PaymentType;
  // UK Faster Payments
  sortCode?: string;
  accountNumber?: string;
  // SEPA / IBAN
  iban?: string;
  bic?: string;
  // M-Pesa / mobile money (format: +2547XXXXXXXX)
  mobileNumber?: string;
  // African bank transfers
  bankCode?: string;
  bankAccountNumber?: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const apiKey = process.env.BRAINROCK_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('BRAINROCK_API_KEY not configured');
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brainrock ${options.method ?? 'GET'} ${path} failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Virtual Accounts ──────────────────────────────────────────────────────────

// Call on user signup — each user gets a unique IBAN for receiving deposits.
// No KYC needed here; Brainrock just assigns an IBAN mapped to FinCruse's master account.
export async function createVirtualAccount(params: {
  userId: string;
  currency: string;   // ISO: GBP, EUR, USD, KES, NGN …
  country: string;    // ISO: GB, KE, NG, US …
}): Promise<VirtualAccount> {
  const res = await apiFetch<{ data: VirtualAccount }>('/virtual-accounts', {
    method: 'POST',
    body: JSON.stringify({
      reference: params.userId,
      currency: params.currency,
      country: params.country,
    }),
  });
  return res.data;
}

export async function getVirtualAccount(accountId: string): Promise<VirtualAccount> {
  const res = await apiFetch<{ data: VirtualAccount }>(`/virtual-accounts/${accountId}`);
  return res.data;
}

// ── Outbound Payments ────────────────────────────────────────────────────────

// Send fiat from FinCruse treasury → user's bank/mobile.
// fromAccountId = BRAINROCK_TREASURY_ACCOUNT_ID (FinCruse's own Brainrock account).
export async function sendPayment(params: {
  fromAccountId: string;
  destination: PaymentDestination;
  amount: number;
  currency: string;
  reference: string;      // FinCruse tracking ID for reconciliation
  description?: string;
}): Promise<OutboundPayment> {
  const res = await apiFetch<{ data: OutboundPayment }>('/payments/outbound', {
    method: 'POST',
    body: JSON.stringify({
      from_account_id: params.fromAccountId,
      to: {
        name:           params.destination.name,
        payment_type:   params.destination.type,
        sort_code:      params.destination.sortCode,
        account_number: params.destination.accountNumber,
        iban:           params.destination.iban,
        bic:            params.destination.bic,
        mobile_number:  params.destination.mobileNumber,
        bank_code:      params.destination.bankCode,
        bank_account_number: params.destination.bankAccountNumber,
      },
      amount:      params.amount,
      currency:    params.currency,
      reference:   params.reference,
      description: params.description ?? 'FinCruse payout',
    }),
  });
  return res.data;
}

export async function getPayment(paymentId: string): Promise<OutboundPayment> {
  const res = await apiFetch<{ data: OutboundPayment }>(`/payments/${paymentId}`);
  return res.data;
}

// ── Webhook signature verification ───────────────────────────────────────────

export function verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
  const secret = process.env.BRAINROCK_WEBHOOK_SECRET ?? '';
  if (!secret) return true; // skip if not configured (dev)

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signatureHeader, 'hex'),
    );
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Infer payment type from currency and what destination fields are provided
export function resolvePaymentType(
  currency: string,
  destination: Partial<PaymentDestination>,
): PaymentType {
  if (destination.mobileNumber) {
    const mobileMoneyCorridors = ['KES', 'TZS', 'UGX', 'GHS', 'NGN', 'ZMW', 'RWF'];
    if (mobileMoneyCorridors.includes(currency.toUpperCase())) return 'mpesa';
  }
  if (destination.iban) {
    return currency.toUpperCase() === 'GBP' ? 'faster_payments' : 'sepa';
  }
  if (destination.sortCode && destination.accountNumber) return 'faster_payments';
  return 'bank_transfer';
}
