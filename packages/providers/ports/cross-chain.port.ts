import type { AssetRef, OpStatus, ProviderHealth } from './common';

export interface CrossChainProvider {
  readonly id: string;
  routes(): Promise<{ from: AssetRef; to: AssetRef; estimatedMinutes: number }[]>;
  quote(p: { from: AssetRef; to: AssetRef; amount: string; toAddress: string }): Promise<{ quoteId: string; amountOut: string; fee: string; expiresAt: Date }>;
  execute(p: { quoteId: string; clientRef: string; fromAddressOrVault: string }): Promise<{ bridgeTxId: string; status: OpStatus }>;
  getStatus(bridgeTxId: string): Promise<{ status: OpStatus; sourceTxHash?: string; destinationTxHash?: string }>;
  health(): Promise<ProviderHealth>;
}
