/**
 * Provider ports — the only way AxLink Core reaches outside itself.
 *
 * Five roles. Every live provider (Fireblocks, B2BinPay, …) is an adapter that implements one
 * or more of these; the core never imports an adapter. The existing seam `src/core/ports.ts`
 * (which mirrors the live provider signatures) stays as-is for the settlement engine until the
 * adapters are mapped onto these interfaces in Step 2 — nothing is rewired in Step 1.
 *
 * Conventions shared by all ports:
 *  - amounts are decimal strings, never floats
 *  - every outbound operation takes our own `clientRef`; a retry with the same ref must not act twice
 *  - every status vocabulary includes a terminal `FAILED` and a non-terminal `PENDING`; an
 *    adapter maps unknown provider states to PENDING (never to success)
 *  - `verifyWebhook` + `parseWebhook` are the only entry for provider callbacks
 */
export interface AssetRef { symbol: string; chain: string; }
export type OpStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';
export interface ProviderHealth { ok: boolean; latencyMs?: number; detail?: string; }
export interface WebhookInput { rawBody: string; headers: Record<string, string | string[] | undefined>; }

export interface CustodyProvider {
  readonly id: string;
  createVault(label: string, clientRef: string): Promise<{ vaultId: string }>;
  getDepositAddress(vaultId: string, asset: AssetRef): Promise<{ address: string; tag?: string }>;
  getBalance(vaultId: string, asset: AssetRef): Promise<{ available: string; pending: string }>;
  transferInternal(p: { clientRef: string; fromVaultId: string; toVaultId: string; asset: AssetRef; amount: string }): Promise<{ providerTxId: string; status: OpStatus }>;
  transferExternal(p: { clientRef: string; fromVaultId: string; toAddress: string; asset: AssetRef; amount: string; memo?: string }): Promise<{ providerTxId: string; status: OpStatus; txHash?: string }>;
  getTransfer(providerTxId: string): Promise<{ status: OpStatus; txHash?: string; final: boolean }>;
  whitelistAddress(label: string, address: string, asset: AssetRef): Promise<void>;
  verifyWebhook(w: WebhookInput): boolean;
  parseWebhook(w: WebhookInput): { kind: 'TRANSFER_STATUS'; providerTxId: string; status: OpStatus; final: boolean; txHash?: string } | { kind: 'DEPOSIT'; vaultId: string; asset: AssetRef; amount: string; txHash: string } | { kind: 'IGNORED' };
  health(): Promise<ProviderHealth>;
}

export interface LiquidityProvider {
  readonly id: string;
  readonly pairs: { base: AssetRef | string; quote: string }[];                 // e.g. USDT ↔ USD, USDT ↔ GBP
  quote(p: { side: 'BUY' | 'SELL'; asset: AssetRef; fiat: string; amount: string; amountIn: 'ASSET' | 'FIAT' }): Promise<{ quoteId: string; rate: string; assetAmount: string; fiatAmount: string; expiresAt: Date }>;
  execute(p: { quoteId: string; clientRef: string }): Promise<{ orderId: string; status: OpStatus }>;
  getOrder(orderId: string): Promise<{ status: OpStatus; filledAsset: string; filledFiat: string }>;
  verifyWebhook(w: WebhookInput): boolean;
  parseWebhook(w: WebhookInput): { kind: 'ORDER_STATUS'; clientRef: string; status: OpStatus; filledAsset: string } | { kind: 'IGNORED' };
  health(): Promise<ProviderHealth>;
}

export interface BlockchainProvider {
  readonly chain: string;
  getTransaction(txHash: string): Promise<{ found: boolean; finalized: boolean; blockTime?: number }>;
  awaitFinality(txHash: string, timeoutMs: number): Promise<{ finalized: boolean }>;
  getTokenBalance(address: string, asset: AssetRef): Promise<string>;
  isValidAddress(address: string): boolean;
  health(): Promise<ProviderHealth>;
}

export interface CrossChainProvider {
  readonly id: string;
  routes(): Promise<{ from: AssetRef; to: AssetRef; estimatedMinutes: number }[]>;
  quote(p: { from: AssetRef; to: AssetRef; amount: string; toAddress: string }): Promise<{ quoteId: string; amountOut: string; fee: string; expiresAt: Date }>;
  execute(p: { quoteId: string; clientRef: string; fromAddressOrVault: string }): Promise<{ bridgeTxId: string; status: OpStatus }>;
  getStatus(bridgeTxId: string): Promise<{ status: OpStatus; sourceTxHash?: string; destinationTxHash?: string }>;
  health(): Promise<ProviderHealth>;
}

export interface FiatPayoutProvider {
  readonly id: string;
  readonly currency: string;
  readonly rails: string[];                                                   // e.g. MPESA_B2C, PESALINK, FPS, SEPA, ACH
  payout(p: { clientRef: string; amount: string; rail: string; beneficiary: Record<string, string> }): Promise<{ providerRef: string; status: OpStatus; reason?: string }>;
  getPayout(providerRef: string): Promise<{ status: OpStatus; reason?: string }>;
  balance(): Promise<{ available: string }>;
  verifyWebhook(w: WebhookInput): boolean;
  parseWebhook(w: WebhookInput): { kind: 'PAYOUT_STATUS'; clientRef: string; status: OpStatus; reason?: string } | { kind: 'INBOUND_CREDIT'; providerRef: string; amount: string; currency: string; reference?: string; payerName?: string } | { kind: 'IGNORED' };
  health(): Promise<ProviderHealth>;
}

/** What each current relationship will implement (Step 2+). Kept here so the mapping is explicit and reviewable. */
export const PROVIDER_ROLES: Record<string, (keyof ProviderRoleMap)[]> = {
  fireblocks: ['custody', 'blockchainExecution'],
  b2binpay: ['liquidity'],
  solanaRpc: ['blockchain'],
};
export interface ProviderRoleMap { custody: CustodyProvider; blockchainExecution: CustodyProvider; liquidity: LiquidityProvider; blockchain: BlockchainProvider; crossChain: CrossChainProvider; fiatPayout: FiatPayoutProvider; }
