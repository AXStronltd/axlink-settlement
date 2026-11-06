import type { AssetRef, ProviderHealth } from './common';

export interface BlockchainProvider {
  readonly chain: string;
  getTransaction(txHash: string): Promise<{ found: boolean; finalized: boolean; blockTime?: number }>;
  awaitFinality(txHash: string, timeoutMs: number): Promise<{ finalized: boolean }>;
  getTokenBalance(address: string, asset: AssetRef): Promise<string>;
  isValidAddress(address: string): boolean;
  health(): Promise<ProviderHealth>;
}
