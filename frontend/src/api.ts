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

// ── Rates ─────────────────────────────────────────────────────────────────────
export const getRates = (symbols: string) => req<unknown>(`/rates?symbols=${symbols}`)

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

// ── Demo ──────────────────────────────────────────────────────────────────────
export const getDemoSteps = (from: string, to: string, amount: number, sender: string, receiver: string) =>
  req<{ summary: Record<string, unknown>; steps: unknown[] }>(`/demo/steps?from=${from}&to=${to}&amount=${amount}&sender=${encodeURIComponent(sender)}&receiver=${encodeURIComponent(receiver)}`)
