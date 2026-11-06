import type { AssetRef, ProviderHealth } from './common';

/** A token movement observed in a finalized transaction, in the token's smallest unit. */
export interface TokenMovement { contract: string; owner: string | null; decimals: number; changeRaw: bigint; }

export interface TransactionDetail {
  found: boolean;
  /** Finalized by the network's own rule (Solana: `finalized` commitment). */
  finalized: boolean;
  /** Landed on chain but failed to execute. Final and never retried. */
  failed: boolean;
  slot?: number;
  blockTime?: Date | null;
  feeRaw?: bigint;
  tokenMovements: TokenMovement[];
  error?: string | null;
}

/** Thrown by awaitFinality when the transaction landed and failed: a settlement failure, not an outage. */
export class ChainTransactionFailed extends Error {
  readonly code = 'CHAIN_TX_FAILED';
  readonly retryable = false;
  constructor(public readonly txHash: string, detail: string) { super(`transaction ${txHash} failed on chain: ${detail}`); }
}

export interface BlockchainProvider {
  readonly chain: string;
  getTransaction(txHash: string): Promise<TransactionDetail>;
  /** Resolves when finalized; throws ChainTransactionFailed on a definite on-chain failure; throws a retryable error when the node is unreachable or still pending. */
  awaitFinality(txHash: string, timeoutMs?: number): Promise<{ finalized: true; slot?: number }>;
  /** Smallest-unit balance of `asset` held by `address`. */
  getTokenBalanceRaw(address: string, asset: AssetRef): Promise<bigint>;
  isValidAddress(address: string): boolean;
  health(): Promise<ProviderHealth>;
}
