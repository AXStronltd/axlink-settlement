import type { AssetRef, OpStatus, ProviderHealth, WebhookInput } from './common';

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
