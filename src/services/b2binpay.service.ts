import crypto from 'crypto';

const BASE_URL = process.env.B2BINPAY_SANDBOX === 'true'
  ? 'https://v3.api-sandbox.b2binpay.com'
  : 'https://sv.v3.api.b2binpay.com';

const CONTENT_TYPE = 'application/vnd.api+json';

interface TokenCache {
  access: string;
  expiresAt: number;
}

interface B2BTransferAttrs {
  status: -3 | -2 | -1 | 0 | 1 | 2;
  amount: string;
  fee: string;
  txid: string | null;
  confirmations: number;
  created_at: string;
  updated_at: string;
}
export type B2BTransferStatus = { id: string } & B2BTransferAttrs;

interface DepositAttrs {
  address: string;
  tracking_id: string;
  callback_url: string;
  status: number;
}
export type DepositAddress = { id: string } & DepositAttrs;

interface PayoutFeeEstimate {
  is_internal: boolean;
  fee: {
    low: string;
    medium: string;
    high: string;
  };
  warning: string | null;
}

interface PayoutAttrs {
  tracking_id: string;
  status: number;
  amount: string;
  fee_amount: string;
}
export type PayoutResult = { id: string } & PayoutAttrs;

let tokenCache: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.access;
  }

  const res = await fetch(`${BASE_URL}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': CONTENT_TYPE, Accept: CONTENT_TYPE },
    body: JSON.stringify({
      data: {
        type: 'auth-token',
        attributes: {
          client_id: process.env.B2BINPAY_CLIENT_ID,
          client_secret: process.env.B2BINPAY_CLIENT_SECRET,
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`B2BinPay auth failed: ${res.status} ${text}`);
  }

  const data = await res.json() as { access: string; expires_in: number };
  tokenCache = {
    access: data.access,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return tokenCache.access;
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': CONTENT_TYPE,
      Accept: CONTENT_TYPE,
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`B2BinPay ${options.method ?? 'GET'} ${path} failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Onramp: create a deposit address ────────────────────────────────────────

export async function createDeposit(params: {
  walletId: string;
  trackingId: string;
  callbackUrl: string;
  label?: string;
  confirmationsNeeded?: number;
}): Promise<DepositAddress> {
  const body = {
    data: {
      type: 'deposit',
      attributes: {
        label: params.label ?? 'FinCruse deposit',
        tracking_id: params.trackingId,
        confirmations_needed: params.confirmationsNeeded ?? 1,
        callback_url: params.callbackUrl,
      },
      relationships: {
        wallet: { data: { type: 'wallet', id: params.walletId } },
      },
    },
  };

  const res = await apiFetch<{ data: { id: string; attributes: DepositAttrs } }>(
    '/deposit/',
    { method: 'POST', body: JSON.stringify(body) },
  );

  return { id: res.data.id, ...res.data.attributes };
}

export async function getDeposit(depositId: string): Promise<DepositAddress> {
  const res = await apiFetch<{ data: { id: string; attributes: DepositAttrs } }>(
    `/deposit/${depositId}`,
  );
  return { id: res.data.id, ...res.data.attributes };
}

// ── Offramp: calculate fees then create payout ───────────────────────────────

export async function calculatePayoutFee(params: {
  walletId: string;
  address: string;
  amount: string;
  currencyId: string;
}): Promise<PayoutFeeEstimate> {
  const body = {
    data: {
      type: 'payout',
      attributes: {
        amount: params.amount,
        address: params.address,
      },
      relationships: {
        wallet: { data: { type: 'wallet', id: params.walletId } },
        currency: { data: { type: 'currency', id: params.currencyId } },
      },
    },
  };

  const res = await apiFetch<{ data: { attributes: PayoutFeeEstimate } }>(
    '/payout/calculate/',
    { method: 'POST', body: JSON.stringify(body) },
  );

  return res.data.attributes;
}

export async function createPayout(params: {
  walletId: string;
  currencyId: string;
  address: string;
  amount: string;
  feeAmount: string;
  trackingId: string;
  callbackUrl: string;
  idempotencyKey: string;
  label?: string;
  confirmationsNeeded?: number;
}): Promise<PayoutResult> {
  const body = {
    data: {
      type: 'payout',
      attributes: {
        amount: params.amount,
        fee_amount: params.feeAmount,
        address: params.address,
        tracking_id: params.trackingId,
        label: params.label ?? 'FinCruse payout',
        callback_url: params.callbackUrl,
        confirmations_needed: params.confirmationsNeeded ?? 1,
      },
      relationships: {
        wallet: { data: { type: 'wallet', id: params.walletId } },
        currency: { data: { type: 'currency', id: params.currencyId } },
      },
    },
  };

  const res = await apiFetch<{ data: { id: string; attributes: PayoutAttrs } }>(
    '/payout/',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'idempotency-key': params.idempotencyKey },
    },
  );

  return { id: res.data.id, ...res.data.attributes };
}

export async function getPayout(payoutId: string): Promise<PayoutResult> {
  const res = await apiFetch<{ data: { id: string; attributes: PayoutAttrs } }>(
    `/payout/${payoutId}`,
  );
  return { id: res.data.id, ...res.data.attributes };
}

// ── Transfer status ──────────────────────────────────────────────────────────

export async function getTransfer(transferId: string): Promise<B2BTransferStatus> {
  const res = await apiFetch<{ data: { id: string; attributes: B2BTransferAttrs } }>(
    `/transfer/${transferId}`,
  );
  return { id: res.data.id, ...res.data.attributes };
}

export const TRANSFER_STATUS: Record<number, string> = {
  [-3]: 'canceled',
  [-2]: 'blocked_aml',
  [-1]: 'failed',
  0: 'queued',
  1: 'unconfirmed',
  2: 'confirmed',
};

// ── Exchange rates ───────────────────────────────────────────────────────────

export async function getRates(left: string | string[]): Promise<unknown> {
  const symbols = Array.isArray(left) ? left.join(',') : left;
  return apiFetch(`/rates/?filter[left]=${encodeURIComponent(symbols)}`);
}

// ── Webhook signature verification ──────────────────────────────────────────

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
): boolean {
  const secret = process.env.B2BINPAY_CALLBACK_SECRET ?? '';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  // constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signatureHeader, 'hex'),
    );
  } catch {
    return false;
  }
}
