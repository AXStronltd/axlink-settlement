import crypto from 'crypto';
import type { ILiquidityProvider, LPRate, LPQuote } from '../../core/lp.interface';

const BASE_URL = process.env.B2BINPAY_SANDBOX === 'true'
  ? 'https://v3.api-sandbox.b2binpay.com'
  : 'https://sv.v3.api.b2binpay.com';

const CONTENT_TYPE = 'application/vnd.api+json';

// ── Sandbox stub detection ───────────────────────────────────────────────────
const PLACEHOLDER = ['your_', 'YOUR_'];
function isConfigured(): boolean {
  const id = process.env.B2BINPAY_CLIENT_ID ?? '';
  return !!(id && !PLACEHOLDER.some(p => id.startsWith(p)));
}

function stubId(prefix: string) {
  return `${prefix}_sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// Hardcoded mid-market rates vs USDT for sandbox (updated June 2025 approximate)
const SANDBOX_RATES: Record<string, number> = {
  KES: 0.00773,   // 1 KES = 0.00773 USDT  (~129 KES/USD)
  UGX: 0.000267,  // 1 UGX = 0.000267 USDT (~3745 UGX/USD)
  NGN: 0.000630,  // 1 NGN = 0.000630 USDT (~1587 NGN/USD)
  GHS: 0.0620,    // 1 GHS = 0.0620 USDT   (~16.1 GHS/USD)
  ZAR: 0.0540,    // 1 ZAR = 0.0540 USDT   (~18.5 ZAR/USD)
  TZS: 0.000373,  // 1 TZS = 0.000373 USDT (~2680 TZS/USD)
  GBP: 1.2700,
  EUR: 1.0800,
  USD: 1.0000,
  CAD: 0.7300,
  USDT: 1.0000,
};

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
  if (!isConfigured()) return 'sandbox_token';

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
  if (!isConfigured()) {
    return { id: stubId('dep'), address: `sandbox_addr_${params.trackingId}`, tracking_id: params.trackingId, callback_url: params.callbackUrl, status: 1 };
  }
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
  if (!isConfigured()) {
    const fee = (parseFloat(params.amount) * 0.003).toFixed(8);
    return { is_internal: false, fee: { low: fee, medium: fee, high: fee }, warning: null };
  }
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
  if (!isConfigured()) {
    return { id: stubId('payout'), tracking_id: params.trackingId, status: 2, amount: params.amount, fee_amount: params.feeAmount };
  }
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
  if (!isConfigured()) {
    const symbols = Array.isArray(left) ? left : [left];
    const data = symbols.flatMap(sym => {
      const mid = SANDBOX_RATES[sym.toUpperCase()];
      if (!mid) return [];
      const spread = mid * 0.002;
      return [{
        id: `${sym.toUpperCase()}:USDT`,
        attributes: { left: sym.toUpperCase(), right: 'USDT', bid: String(mid - spread), ask: String(mid + spread) },
      }];
    });
    return { data };
  }
  const symbols = Array.isArray(left) ? left.join(',') : left;
  return apiFetch(`/rates/?filter[left]=${encodeURIComponent(symbols)}`);
}

// ── B2BinPay as AxLink LP ────────────────────────────────────────────────────
// B2BinPay is a registered LP in the AxLink JIT RFQ system.
// They compete in the RFQ broadcast for any supported pair.
// If another LP beats their rate, B2BinPay does not execute — no cost.

// Currencies B2BinPay can quote (via USDT bridge)
const B2B_SUPPORTED = new Set([
  'KES', 'UGX', 'NGN', 'GHS', 'ZAR', 'TZS',   // African fiat
  'GBP', 'EUR', 'USD', 'CAD',                    // Major fiat
  'BTC', 'ETH', 'SOL', 'USDT',                   // Crypto
]);

export const b2binpayLP: ILiquidityProvider = {
  id:   'b2binpay',
  name: 'B2BinPay',

  supportsRate(from: string, to: string): boolean {
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    // Must have at least one USD/USDT anchor side, or both in supported set
    return B2B_SUPPORTED.has(f) && (t === 'USD' || t === 'USDT' || B2B_SUPPORTED.has(t));
  },

  async getRate(from: string, to: string): Promise<LPRate> {
    const fromN = from.toUpperCase();
    const toN   = to.toUpperCase();
    const now   = Date.now();
    if (fromN === toN) return { bid: 1, ask: 1, mid: 1, spread: 0, spreadPct: 0, fetchedAt: now, source: 'b2binpay' };

    const fromUsdt = SANDBOX_RATES[fromN] ?? 1;
    const toUsdt   = SANDBOX_RATES[toN]   ?? 1;
    const mid      = fromUsdt / toUsdt;
    const spread   = mid * 0.002;
    return { bid: mid - spread, ask: mid + spread, mid, spread: spread * 2, spreadPct: (spread * 2) / mid, fetchedAt: now, source: 'b2binpay' };
  },

  async requestQuote(from: string, to: string, fromAmount: number): Promise<LPQuote> {
    const fromN = from.toUpperCase();
    const toN   = to.toUpperCase();

    if (!isConfigured()) {
      // Sandbox: use our rate table + simulate a small spread
      const fromUsdt = SANDBOX_RATES[fromN] ?? 1;
      const toUsdt   = SANDBOX_RATES[toN]   ?? 1;
      const mid      = fromUsdt / toUsdt;
      const spread   = mid * 0.003;          // 0.3% B2BinPay institutional spread
      const rate     = mid - spread;         // client rate (bid)
      return {
        id:         `b2bp_q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        from:       fromN,
        to:         toN,
        fromAmount,
        toAmount:   parseFloat((fromAmount * rate).toFixed(8)),
        rate,
        validUntil: Date.now() + 30_000,    // 30s binding window
        source:     'b2binpay',
        raw:        { sandbox: true, fromUsdt, toUsdt, mid, spread },
      };
    }

    // Production: call B2BinPay rates API for live quote
    const rateData = await getRates([fromN]) as {
      data?: { attributes?: { left: string; right: string; bid: string; ask: string } }[]
    };
    let mid = 1;
    for (const item of rateData.data ?? []) {
      const a = item.attributes;
      if (!a) continue;
      const b = parseFloat(a.bid);
      const ask = parseFloat(a.ask);
      if (a.left.toUpperCase() === fromN && (a.right.toUpperCase() === 'USDT' || a.right.toUpperCase() === 'USD')) {
        mid = (b + ask) / 2;
      }
    }
    const toRate   = SANDBOX_RATES[toN] ?? 1;
    const crossMid = mid / toRate;
    const rate     = crossMid * 0.997;
    return {
      id:         `b2bp_q_${Date.now()}`,
      from:       fromN,
      to:         toN,
      fromAmount,
      toAmount:   parseFloat((fromAmount * rate).toFixed(8)),
      rate,
      validUntil: Date.now() + 30_000,
      source:     'b2binpay',
      raw:        { mid },
    };
  },
};

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
