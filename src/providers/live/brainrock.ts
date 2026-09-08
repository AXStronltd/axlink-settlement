import crypto from 'crypto';
import type { PaymentDestination } from '../../core/baas.interface';

// ── Brainrock BaaS — Fiat banking layer ──────────────────────────────────────
// Provides per-user virtual IBANs and outbound fiat payments.
// Compatible pattern: swap BASE_URL + field names for Square, Railsr, ClearBank.
//
// Inbound:  User bank → user's virtual IBAN → Brainrock webhook → AxLink
// Outbound: AxLink treasury account → user's bank / M-Pesa / SEPA

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
  | 'ach'               // USA — routing number + account number
  | 'eft';              // Canada — transit + institution + account

// Re-exported for backwards compatibility — canonical definition is in baas.interface.ts
export type { PaymentDestination } from '../../core/baas.interface';

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
// No KYC needed here; Brainrock just assigns an IBAN mapped to AxLink's master account.
export async function createVirtualAccount(params: {
  userId: string;
  currency: string;   // ISO: GBP, EUR, USD, CAD
  country: string;    // ISO: GB, US, CA, DE, FR …
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

// Send fiat from AxLink treasury → user's bank/mobile.
// fromAccountId = BRAINROCK_TREASURY_ACCOUNT_ID (AxLink's own Brainrock account).

// ── Sandbox stub ─────────────────────────────────────────────────────────────
// Matches the contract B2BinPay, Fireblocks and Daraja already follow: a real
// call when credentials are present, a shaped stub when they are not. Without
// it no corridor ending at this partner could be exercised locally, which is
// how a broken payout path stays invisible until production.
const PLACEHOLDER_PREFIXES = ['your_', 'YOUR_', 'sandbox_'];
function isConfigured(value: string | undefined): boolean {
  const v = value ?? '';
  return !!v && !PLACEHOLDER_PREFIXES.some(p => v.startsWith(p));
}
function stubRef(prefix: string): string {
  return `${prefix}_sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function sendPayment(params: {
  fromAccountId: string;
  destination: PaymentDestination;
  amount: number;
  currency: string;
  reference: string;      // AxLink tracking ID for reconciliation
  description?: string;
}): Promise<OutboundPayment> {
  if (!isConfigured(process.env.BRAINROCK_API_KEY)) {
    const id = stubRef('brpay');
    const where = params.destination.iban ?? params.destination.accountNumber ?? params.destination.mobileNumber ?? '-';
    console.log(`[Brainrock] SANDBOX — would send ${params.amount} ${params.currency} to ${where} (${id})`);
    return {
      id, status: 'processing', amount: params.amount,
      currency: params.currency, reference: params.reference,
    };
  }

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
      description: params.description ?? 'AxLink payout',
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

// ── Card Issuance ─────────────────────────────────────────────────────────────
// Brainrock (or any card provider) issues a virtual or physical debit card
// linked to AxLink's program. Authorization webhooks come back to AxLink.

export interface CardDetails {
  id:       string;    // store as Card.providerCardId
  last4:    string;
  brand:    'visa' | 'mastercard';
  cardType: 'virtual' | 'physical';
  currency: string;
  status:   'ACTIVE' | 'FROZEN' | 'CANCELLED';
}

function isBrainrockConfigured(): boolean {
  const key = process.env.BRAINROCK_API_KEY ?? '';
  return !!(key && !key.startsWith('your_') && !key.startsWith('YOUR_'));
}

function sandboxCard(userId: string, currency: string, cardType: 'virtual' | 'physical'): CardDetails {
  return {
    id:       `card_sbx_${userId.slice(-8)}_${Date.now()}`,
    last4:    String(1000 + Math.floor(Math.random() * 9000)).slice(0, 4),
    brand:    'visa',
    cardType,
    currency,
    status:   'ACTIVE',
  };
}

export async function issueCard(params: {
  userId: string;
  currency: string;
  cardType?: 'virtual' | 'physical';
  cardholderName: string;
}): Promise<CardDetails> {
  const cardType = params.cardType ?? 'virtual';

  if (!isBrainrockConfigured()) {
    console.warn('[Brainrock] Not configured — returning sandbox stub card');
    return sandboxCard(params.userId, params.currency, cardType);
  }

  const res = await apiFetch<{ data: CardDetails }>('/cards', {
    method: 'POST',
    body: JSON.stringify({
      reference:       params.userId,
      currency:        params.currency,
      card_type:       cardType,
      cardholder_name: params.cardholderName,
      program_id:      process.env.BRAINROCK_CARD_PROGRAM_ID ?? '',
    }),
  });
  return res.data;
}

export async function getCard(cardId: string): Promise<CardDetails> {
  if (!isBrainrockConfigured()) return { id: cardId, last4: '0000', brand: 'visa', cardType: 'virtual', currency: 'USD', status: 'ACTIVE' };
  const res = await apiFetch<{ data: CardDetails }>(`/cards/${cardId}`);
  return res.data;
}

export async function freezeCard(cardId: string): Promise<CardDetails> {
  if (!isBrainrockConfigured()) return { id: cardId, last4: '0000', brand: 'visa', cardType: 'virtual', currency: 'USD', status: 'FROZEN' };
  const res = await apiFetch<{ data: CardDetails }>(`/cards/${cardId}/freeze`, { method: 'POST' });
  return res.data;
}

export async function unfreezeCard(cardId: string): Promise<CardDetails> {
  if (!isBrainrockConfigured()) return { id: cardId, last4: '0000', brand: 'visa', cardType: 'virtual', currency: 'USD', status: 'ACTIVE' };
  const res = await apiFetch<{ data: CardDetails }>(`/cards/${cardId}/unfreeze`, { method: 'POST' });
  return res.data;
}

// Respond to a Brainrock authorization request — must be called within 100ms
// Returns the decision payload Brainrock expects back on its auth callback endpoint
export function buildAuthDecision(approved: boolean, authorizationId: string, reason?: string) {
  return {
    authorization_id: authorizationId,
    decision:         approved ? 'approved' : 'declined',
    decline_reason:   reason ?? null,
    timestamp:        new Date().toISOString(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Infer Brainrock payment type — EU/UK/USA/Canada only
export function resolvePaymentType(
  currency: string,
  destination: Partial<PaymentDestination>,
): PaymentType {
  const ccy = currency.toUpperCase();
  if (destination.sortCode && destination.accountNumber) return 'faster_payments';
  if (destination.iban) return ccy === 'GBP' ? 'faster_payments' : 'sepa';
  if (destination.routingNumber) return 'ach';
  if (destination.transitNumber)  return 'eft';
  if (ccy === 'GBP')  return 'faster_payments';
  if (ccy === 'EUR')  return 'sepa';
  if (ccy === 'USD')  return 'ach';
  if (ccy === 'CAD')  return 'eft';
  return 'swift';
}

// ── Payment Sessions (Add Funds: Apple Pay / Google Pay / Open Banking) ───────

export type DepositMethod = 'apple_pay' | 'google_pay' | 'open_banking' | 'bank_transfer';

export interface PaymentSession {
  sessionId:    string;   // Brainrock session ID — stored on BankDeposit.sessionId
  checkoutUrl:  string;   // Redirect URL (Open Banking) or JS SDK token URL
  clientToken?: string;   // Apple Pay / Google Pay SDK token (web SDK flow)
  method:       DepositMethod;
  currency:     string;
  amount:       number;
  expiresAt:    string;   // ISO timestamp — session valid for 15 min
}

interface BrainrockSessionResponse {
  id:            string;
  checkout_url:  string;
  client_token?: string;
  expires_at:    string;
}

// Creates a Brainrock-hosted payment session.
// User pays via Apple Pay sheet / Google Pay sheet / Open Banking redirect.
// Fiat lands in AxLink's Brainrock segregated account.
// Brainrock fires payment.received webhook → handleFiatArrived → B2BinPay → USDT → vault.
export async function createPaymentSession(params: {
  userId:       string;
  currency:     string;       // GBP, EUR, USD, CAD, AED
  amount:       number;
  method:       DepositMethod;
  trackingId:   string;       // AxLink deposit tracking ID — echoed back in webhook
  redirectUrl?: string;       // where to send user after Open Banking auth
}): Promise<PaymentSession> {
  const { userId, currency, amount, method, trackingId, redirectUrl } = params;

  // Sandbox mode — return a realistic fake session when credentials aren't configured.
  // The ops panel can then fire the webhook manually to complete the flow.
  if (!isBrainrockConfigured()) {
    const sandboxSessionId = `sess_sandbox_${trackingId.slice(4, 20)}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000/api';
    return {
      sessionId:   sandboxSessionId,
      checkoutUrl: `${baseUrl}/sandbox/open-banking?session=${sandboxSessionId}&amount=${amount}&currency=${currency}&ref=${trackingId}`,
      clientToken: method !== 'open_banking' ? `tok_sandbox_${sandboxSessionId}` : undefined,
      method,
      currency:    currency.toUpperCase(),
      amount,
      expiresAt,
    };
  }

  // Where the customer lands after paying. Falling back to a guessed domain
  // meant an unset APP_URL sent them to a host that may not resolve — after
  // their money had moved. Refuse to open the session instead: failing before
  // the payment is recoverable, stranding someone after it is not.
  const returnUrl = redirectUrl ?? (
    process.env.APP_URL
      ? `${process.env.APP_URL}/deposit/confirm`
      : (() => {
          throw new Error(
            'Cannot create a payment session: APP_URL is not set and no redirectUrl was ' +
            'given, so there is nowhere to send the customer after they pay.',
          );
        })()
  );

  const session = await apiFetch<BrainrockSessionResponse>('/payment-sessions', {
    method: 'POST',
    body: JSON.stringify({
      amount,
      currency:       currency.toUpperCase(),
      payment_method: method,
      reference:      trackingId,
      customer_id:    userId,
      redirect_url:   returnUrl,
      webhook_url:    `${process.env.API_BASE_URL}/webhooks/brainrock`,
      metadata: { tracking_id: trackingId, source: 'axlink_add_funds' },
    }),
  });

  return {
    sessionId:   session.id,
    checkoutUrl: session.checkout_url,
    clientToken: session.client_token,
    method,
    currency:    currency.toUpperCase(),
    amount,
    expiresAt:   session.expires_at,
  };
}
