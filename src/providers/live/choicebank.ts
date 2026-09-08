import crypto from 'crypto';

// ── Choice Bank — African Bank Transfers ─────────────────────────────────────
// Handles outbound bank payments across NGN, GHS, ZAR, and KES corridors.
// Inbound: virtual account assigned per user; webhook fires on receipt.
// Outbound: POST /transfers → bank account in Nigeria / Ghana / South Africa.
//
// Set CHOICE_BANK_SANDBOX=true to hit sandbox.choicebank.ng instead.

const BASE_URL = process.env.CHOICE_BANK_SANDBOX === 'true'
  ? 'https://sandbox.api.choicebank.ng/v1'
  : 'https://api.choicebank.ng/v1';

// Supported corridors
export const CHOICE_BANK_CURRENCIES = ['NGN', 'GHS', 'ZAR', 'KES'] as const;
export type ChoiceBankCurrency = typeof CHOICE_BANK_CURRENCIES[number];

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChoiceBankVirtualAccount {
  id: string;            // store as User.choiceBankAccountId
  accountNumber: string; // user's deposit account number
  bankCode: string;      // bank routing code (e.g. "058" for GTBank)
  bankName: string;
  currency: ChoiceBankCurrency;
  status: 'active' | 'inactive';
}

export interface ChoiceBankTransfer {
  id: string;
  reference: string;
  status: 'pending' | 'processing' | 'success' | 'failed';
  amount: number;
  currency: ChoiceBankCurrency;
  recipientName: string;
  recipientAccountNumber: string;
  recipientBankCode: string;
  failureReason?: string;
  completedAt?: string;
}

export interface ChoiceBankBalance {
  currency: ChoiceBankCurrency;
  available: number;
  ledger: number;
}

// ── Destination types ─────────────────────────────────────────────────────────

export interface ChoiceBankDestination {
  accountNumber: string;
  bankCode: string;         // NIP bank code for NGN, GH bank code for GHS, etc.
  accountName: string;
  currency: ChoiceBankCurrency;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const apiKey = process.env.CHOICE_BANK_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('CHOICE_BANK_API_KEY not configured');
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
    throw new Error(`ChoiceBank ${options.method ?? 'GET'} ${path} failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Virtual Accounts ──────────────────────────────────────────────────────────

// Create a dedicated deposit account for a AxLink user.
// Each user gets a unique account number — deposits trigger a webhook to AxLink.
export async function createVirtualAccount(params: {
  userId: string;
  currency: ChoiceBankCurrency;
  firstName: string;
  lastName: string;
  bvn?: string;   // Bank Verification Number — required for NGN KYC
}): Promise<ChoiceBankVirtualAccount> {
  const res = await apiFetch<{ data: ChoiceBankVirtualAccount }>('/virtual-accounts', {
    method: 'POST',
    body: JSON.stringify({
      reference:   params.userId,
      currency:    params.currency,
      first_name:  params.firstName,
      last_name:   params.lastName,
      bvn:         params.bvn,
    }),
  });
  return res.data;
}

export async function getVirtualAccount(accountId: string): Promise<ChoiceBankVirtualAccount> {
  const res = await apiFetch<{ data: ChoiceBankVirtualAccount }>(`/virtual-accounts/${accountId}`);
  return res.data;
}

// ── Bank List (NIP resolution) ────────────────────────────────────────────────

export interface ChoiceBankBank {
  code: string;
  name: string;
  country: string;
}

export async function getBanks(currency: ChoiceBankCurrency): Promise<ChoiceBankBank[]> {
  const res = await apiFetch<{ data: ChoiceBankBank[] }>(`/banks?currency=${currency}`);
  return res.data;
}

// Resolve account name before initiating transfer (NIP name enquiry)
export async function resolveAccountName(params: {
  accountNumber: string;
  bankCode: string;
  currency: ChoiceBankCurrency;
}): Promise<{ accountName: string; accountNumber: string }> {
  const res = await apiFetch<{ data: { account_name: string; account_number: string } }>(
    '/accounts/resolve',
    {
      method: 'POST',
      body: JSON.stringify({
        account_number: params.accountNumber,
        bank_code:      params.bankCode,
        currency:       params.currency,
      }),
    },
  );
  return {
    accountName:   res.data.account_name,
    accountNumber: res.data.account_number,
  };
}

// ── Outbound Transfers ────────────────────────────────────────────────────────

// Send fiat from AxLink treasury → recipient's bank account.
// reference = AxLink trackingId for reconciliation.
export async function sendTransfer(params: {
  destination: ChoiceBankDestination;
  amount: number;
  reference: string;
  narration?: string;
}): Promise<ChoiceBankTransfer> {
  const { destination, amount, reference, narration } = params;
  const res = await apiFetch<{ data: ChoiceBankTransfer }>('/transfers', {
    method: 'POST',
    body: JSON.stringify({
      account_number: destination.accountNumber,
      bank_code:      destination.bankCode,
      account_name:   destination.accountName,
      amount,
      currency:       destination.currency,
      reference,
      narration:      narration ?? 'AxLink payout',
    }),
  });
  return res.data;
}

export async function getTransfer(transferId: string): Promise<ChoiceBankTransfer> {
  const res = await apiFetch<{ data: ChoiceBankTransfer }>(`/transfers/${transferId}`);
  return res.data;
}

// Fetch transfer by reference (idempotent retry-safe lookup)
export async function getTransferByReference(reference: string): Promise<ChoiceBankTransfer | null> {
  try {
    const res = await apiFetch<{ data: ChoiceBankTransfer }>(`/transfers/reference/${reference}`);
    return res.data;
  } catch {
    return null;
  }
}

// ── Balance ───────────────────────────────────────────────────────────────────

export async function getBalance(currency: ChoiceBankCurrency): Promise<ChoiceBankBalance> {
  const res = await apiFetch<{ data: ChoiceBankBalance }>(`/balances/${currency}`);
  return res.data;
}

// ── Webhook signature verification ───────────────────────────────────────────

export function verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
  const secret = process.env.CHOICE_BANK_WEBHOOK_SECRET ?? '';
  if (!secret) return true; // skip if not configured (dev)

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signatureHeader.replace('sha256=', ''), 'hex'),
    );
  } catch {
    return false;
  }
}

// ── Corridor helper ───────────────────────────────────────────────────────────

export function isChoiceBankCurrency(currency: string): currency is ChoiceBankCurrency {
  return CHOICE_BANK_CURRENCIES.includes(currency.toUpperCase() as ChoiceBankCurrency);
}
