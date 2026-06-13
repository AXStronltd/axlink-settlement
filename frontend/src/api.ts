const BASE = '/api'

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data as T
}

// ── Health ────────────────────────────────────────────────────────────────────
export type Health = { status: string; service: string; timestamp: string; sandbox: boolean; callbackBase: string }
export const getHealth = () => req<Health>('/health')

// ── Users ─────────────────────────────────────────────────────────────────────
export type Account = { currency: string; balance: number; balanceUsd: number }
export type User = {
  id: string; email: string; name: string; kycStatus: string
  accounts: Account[]
  vaultId?: string; virtualIban?: string; virtualIbanBic?: string
}
export type CreateUserRes = { userId: string; vaultId: string; currency: string; depositAccount: { iban: string; bic: string; currency: string } | null }

export const createUser = (body: { email: string; name: string; currency: string }) =>
  req<CreateUserRes>('/users', { method: 'POST', body: JSON.stringify(body) })

export const getUser = (id: string) => req<User>(`/users/${id}`)

export const lookupUser = (email: string) =>
  req<{ id: string; name: string; email: string; currency: string }>(`/users/lookup?email=${encodeURIComponent(email)}`)

// ── Quote ─────────────────────────────────────────────────────────────────────
export type QuoteRes = {
  quoteId: string; status: string
  from: { currency: string; amount: number }
  to: { currency: string; amount: number }
  rate: number; fee: string
  rfq: { winningLP: string; lpRate: number; customerRate: number; axlinkSpread: string; registeredLPs: string[] }
  revenueModel: { profitPerTx: string; vsTraditional: string; fireblocksGas: string; swiftNotPaid: string }
  expiresIn: number; expiresAt: string; jit: boolean
}
export const createQuote = (body: { fromCurrency: string; toCurrency: string; fromAmount: number }) =>
  req<QuoteRes>('/quote', { method: 'POST', body: JSON.stringify(body) })

export const getQuote = (id: string) => req<QuoteRes>(`/quote/${id}`)

// ── Orchestrator ──────────────────────────────────────────────────────────────
export type TransferRes = {
  transferId: string; trackingId: string; status: string
  flow: string; fromAmount: number; toAmount: number; fxRate: number
  b2binpayCalls: number; fireblocksCalls: number
}
export const orchestratorTransfer = (body: {
  senderId: string; receiverId: string
  fromCurrency: string; toCurrency: string
  amount: number; quoteId?: string; note?: string
}) => req<TransferRes>('/orchestrator/transfer', { method: 'POST', body: JSON.stringify(body) })

export type WithdrawRes = { withdrawalId: string; trackingId: string; status: string; flow: string; message: string }
export const orchestratorWithdraw = (body: {
  userId: string; currency: string; amount: number
  recipientName: string; destination: Record<string, string>
}) => req<WithdrawRes>('/orchestrator/withdraw', { method: 'POST', body: JSON.stringify(body) })

export type DepositRes = { depositId: string; trackingId: string; status: string; flow: string; message: string }
export const triggerDeposit = (body: {
  userId: string; currency: string; amount: number; rail: string; railReference: string
}) => req<DepositRes>('/orchestrator/payout-rail/fiat-arrived', { method: 'POST', body: JSON.stringify(body) })

// ── Add Funds (user-initiated: Apple Pay / Google Pay / Open Banking) ─────────
export type DepositMethod = 'apple_pay' | 'google_pay' | 'open_banking' | 'bank_transfer'

export type InitiateDepositRes = {
  depositId:     string
  trackingId:    string
  method:        DepositMethod
  currency:      string
  amount:        number
  usdEquivalent: number
  status:        string
  checkoutUrl:   string
  clientToken?:  string
  sessionId:     string
  expiresAt:     string
  segregatedAccount: { note: string; provider: string }
}

export type DepositStatusRes = {
  id: string; trackingId: string; currency: string; amount: number; usdAmount: number
  method: string | null; status: string; statusLabel: string; flow: string
  sessionId: string | null; onrampId: string | null; fbTxId: string | null
  createdAt: string; updatedAt: string
}

export const getDepositMethods = (currency: string) =>
  req<{ currency: string; methods: DepositMethod[]; available: boolean }>(`/deposits/methods?currency=${currency}`)

export const initiateDeposit = (body: { userId: string; currency: string; amount: number; method: DepositMethod }) =>
  req<InitiateDepositRes>('/deposits/initiate', { method: 'POST', body: JSON.stringify(body) })

export const getDepositStatus = (depositId: string, userId: string) =>
  req<DepositStatusRes>(`/deposits/${depositId}?userId=${userId}`)

export const listDeposits = (userId: string) =>
  req<{ deposits: DepositStatusRes[]; total: number }>(`/deposits?userId=${userId}`)

// ── Simulate ──────────────────────────────────────────────────────────────────
export interface SimStep {
  step: number; total: number; layer: string; action: string; detail: string; duration: number
  money: { label: string; amount: string; currency: string; direction: 'debit' | 'credit' | 'move' | 'info' }[]
  status: 'running' | 'done' | 'error'
}
export const simulateTransfer = (from: string, to: string, amount: number) =>
  req<{ steps: SimStep[] }>(`/simulate/transfer?from=${from}&to=${to}&amount=${amount}`)

export const simulateDeposit = (currency: string, amount: number, rail: string) =>
  req<{ steps: SimStep[] }>(`/simulate/deposit?currency=${currency}&amount=${amount}&rail=${rail}`)

export const simulateWithdraw = (currency: string, amount: number, rail: string) =>
  req<{ steps: SimStep[] }>(`/simulate/withdraw?currency=${currency}&amount=${amount}&rail=${rail}`)

