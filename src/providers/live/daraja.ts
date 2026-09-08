// ── Daraja API — M-Pesa Direct Integration ───────────────────────────────────
// Safaricom Daraja v3 — last-mile M-Pesa delivery for TZS, UGX.
// KES (Kenya) bank payouts are routed through Choice Bank.
//
// B2C (Business to Customer): APPRA → user's M-Pesa wallet (withdrawals/payouts)
// STK Push (C2B lipa na M-Pesa): user's M-Pesa → APPRA (deposits)
//
// Docs: https://developer.safaricom.co.ke/APIs/MpesaExpressSimulate
// Set DARAJA_SANDBOX=true to use sandbox.safaricom.co.ke

const BASE_URL = process.env.DARAJA_SANDBOX === 'true'
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

export const DARAJA_CURRENCIES = ['TZS', 'UGX'] as const;
export type DarajaCurrency = typeof DARAJA_CURRENCIES[number];

// ── OAuth token cache ─────────────────────────────────────────────────────────

let _token: string | null = null;
let _tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const consumerKey    = process.env.DARAJA_CONSUMER_KEY ?? '';
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET ?? '';

  if (!consumerKey || consumerKey.startsWith('your_')) {
    throw new Error('DARAJA_CONSUMER_KEY not configured');
  }

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const res = await fetch(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } },
  );

  if (!res.ok) {
    throw new Error(`Daraja OAuth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string; expires_in: string };
  _token = data.access_token;
  _tokenExpiry = Date.now() + (Number(data.expires_in) - 30) * 1000;
  return _token;
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Daraja ${options.method ?? 'GET'} ${path} failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface B2CResult {
  ConversationID:      string;
  OriginatorConversationID: string;
  ResponseCode:        string;   // '0' = accepted (queued, not yet sent)
  ResponseDescription: string;
}

export interface B2CCallback {
  Result: {
    ResultType:        number;
    ResultCode:        number;    // 0 = success
    ResultDesc:        string;
    OriginatorConversationID: string;
    ConversationID:    string;
    TransactionID:     string;   // M-Pesa receipt number
    ResultParameters?: {
      ResultParameter: Array<{ Key: string; Value: string | number }>;
    };
  };
}

export interface STKPushResult {
  MerchantRequestID:   string;
  CheckoutRequestID:   string;
  ResponseCode:        string;
  ResponseDescription: string;
  CustomerMessage:     string;
}

export interface STKCallbackResult {
  Body: {
    stkCallback: {
      MerchantRequestID:   string;
      CheckoutRequestID:   string;
      ResultCode:          number;   // 0 = success
      ResultDesc:          string;
      CallbackMetadata?: {
        Item: Array<{ Name: string; Value?: string | number }>;
      };
    };
  };
}

// ── B2C — Business to Customer (Withdrawals / Payouts) ───────────────────────

// Sends money from APPRA's M-Pesa shortcode → user's mobile number.
// commandId:
//   'BusinessPayment'     — standard payout (most cases)
//   'SalaryPayment'       — payroll
//   'PromotionPayment'    — promotions/cashback

// ── Sandbox stub ─────────────────────────────────────────────────────────────
// B2BinPay and Fireblocks already return stub responses when their credentials
// are absent, which is what lets the service boot and quote in sandbox. The
// payout partners did not, so any withdrawal died at the partner call and no
// corridor could be exercised locally. Same contract as the other two: real
// call when configured, shaped stub when not.
const PLACEHOLDER_PREFIXES = ['your_', 'YOUR_', 'sandbox_'];
function isConfigured(value: string | undefined): boolean {
  const v = value ?? '';
  return !!v && !PLACEHOLDER_PREFIXES.some(p => v.startsWith(p));
}
function stubRef(prefix: string): string {
  return `${prefix}_sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function sendB2C(params: {
  amount: number;
  phoneNumber: string;   // format: 2547XXXXXXXX (no leading +)
  reference: string;     // APPRA trackingId
  occasion?: string;     // short description shown to recipient
  commandId?: 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment';
}): Promise<B2CResult> {
  if (!isConfigured(process.env.DARAJA_CONSUMER_KEY)) {
    const id = stubRef('daraja');
    console.log(`[Daraja] SANDBOX — would send ${params.amount} KES to ${normalizeMsisdn(params.phoneNumber)} (${id})`);
    return {
      ConversationID: id,
      OriginatorConversationID: params.reference,
      ResponseCode: '0',
      ResponseDescription: 'Accepted for processing (sandbox stub)',
    };
  }

  const shortcode    = process.env.DARAJA_SHORTCODE ?? '';
  const callbackBase = process.env.API_BASE_URL ?? '';

  const res = await apiFetch<B2CResult>('/mpesa/b2c/v3/paymentrequest', {
    method: 'POST',
    body: JSON.stringify({
      OriginatorConversationID: params.reference,
      InitiatorName:            process.env.DARAJA_INITIATOR_NAME ?? 'APPRA',
      SecurityCredential:       process.env.DARAJA_SECURITY_CREDENTIAL ?? '',
      CommandID:                params.commandId ?? 'BusinessPayment',
      Amount:                   Math.round(params.amount),
      PartyA:                   shortcode,
      PartyB:                   normalizeMsisdn(params.phoneNumber),
      Remarks:                  params.occasion ?? 'APPRA payout',
      QueueTimeOutURL:          `${callbackBase}/webhooks/daraja/b2c/timeout`,
      ResultURL:                `${callbackBase}/webhooks/daraja/b2c/result`,
      Occasion:                 params.occasion ?? '',
    }),
  });

  return res;
}

// ── STK Push — Customer pays APPRA (Deposits) ─────────────────────────────

// Prompts user's M-Pesa PIN screen on their phone.
// Use for accepting deposits from customers.
export async function initiateSTKPush(params: {
  amount: number;
  phoneNumber: string;  // 2547XXXXXXXX
  accountReference: string;  // shows on customer's M-Pesa receipt
  description?: string;
}): Promise<STKPushResult> {
  const shortcode = process.env.DARAJA_SHORTCODE ?? '';
  const passkey   = process.env.DARAJA_PASSKEY ?? '';
  const callbackBase = process.env.API_BASE_URL ?? '';

  const timestamp = getMpesaTimestamp();
  const password  = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

  const res = await apiFetch<STKPushResult>('/mpesa/stkpush/v1/processrequest', {
    method: 'POST',
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.round(params.amount),
      PartyA:            normalizeMsisdn(params.phoneNumber),
      PartyB:            shortcode,
      PhoneNumber:       normalizeMsisdn(params.phoneNumber),
      CallBackURL:       `${callbackBase}/webhooks/daraja/stk`,
      AccountReference:  params.accountReference,
      TransactionDesc:   params.description ?? 'APPRA deposit',
    }),
  });

  return res;
}

// ── STK Push status query ─────────────────────────────────────────────────────

export async function queryStkStatus(checkoutRequestId: string): Promise<{
  ResultCode: string;
  ResultDesc: string;
}> {
  const shortcode   = process.env.DARAJA_SHORTCODE ?? '';
  const passkey     = process.env.DARAJA_PASSKEY ?? '';
  const timestamp   = getMpesaTimestamp();
  const password    = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

  return apiFetch('/mpesa/stkpushquery/v1/query', {
    method: 'POST',
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password:          password,
      Timestamp:         timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  });
}

// ── Callback parsers ──────────────────────────────────────────────────────────

// Parse a B2C result callback from Safaricom.
// Returns null if still pending.
export function parseB2CCallback(body: B2CCallback): {
  success: boolean;
  conversationId: string;
  transactionId?: string;
  amount?: number;
  phone?: string;
  failureReason?: string;
} {
  const result = body.Result;
  const success = result.ResultCode === 0;

  let transactionId: string | undefined;
  let amount: number | undefined;
  let phone: string | undefined;

  if (success && result.ResultParameters) {
    for (const p of result.ResultParameters.ResultParameter) {
      if (p.Key === 'TransactionID')     transactionId = String(p.Value);
      if (p.Key === 'TransactionAmount') amount = Number(p.Value);
      if (p.Key === 'ReceiverPartyPublicName') phone = String(p.Value).split(' ')[0];
    }
  }

  return {
    success,
    conversationId: result.ConversationID,
    transactionId,
    amount,
    phone,
    failureReason: success ? undefined : result.ResultDesc,
  };
}

// Parse STK push callback from Safaricom.
export function parseSTKCallback(body: STKCallbackResult): {
  success: boolean;
  checkoutRequestId: string;
  mpesaReceiptNumber?: string;
  amount?: number;
  phone?: string;
  failureReason?: string;
} {
  const cb = body.Body.stkCallback;
  const success = cb.ResultCode === 0;

  let mpesaReceiptNumber: string | undefined;
  let amount: number | undefined;
  let phone: string | undefined;

  if (success && cb.CallbackMetadata) {
    for (const item of cb.CallbackMetadata.Item) {
      if (item.Name === 'MpesaReceiptNumber') mpesaReceiptNumber = String(item.Value ?? '');
      if (item.Name === 'Amount')             amount = Number(item.Value ?? 0);
      if (item.Name === 'PhoneNumber')        phone  = String(item.Value ?? '');
    }
  }

  return {
    success,
    checkoutRequestId: cb.CheckoutRequestID,
    mpesaReceiptNumber,
    amount,
    phone,
    failureReason: success ? undefined : cb.ResultDesc,
  };
}

// ── Corridor helper ───────────────────────────────────────────────────────────

export function isDarajaCurrency(currency: string): currency is DarajaCurrency {
  return DARAJA_CURRENCIES.includes(currency.toUpperCase() as DarajaCurrency);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Normalize phone to MSISDN format: 2547XXXXXXXX (12 digits, no +)
export function normalizeMsisdn(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith('254'))                        return digits;
  if (digits.startsWith('7') && digits.length === 9)   return `254${digits}`;
  return digits;
}

// Daraja timestamp: YYYYMMDDHHmmss
function getMpesaTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}
