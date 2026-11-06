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
export * from './common';
export * from './custody.port';
export * from './liquidity.port';
export * from './blockchain.port';
export * from './cross-chain.port';
export * from './fiat-payout.port';
import type { CustodyProvider } from './custody.port';
import type { LiquidityProvider } from './liquidity.port';
import type { BlockchainProvider } from './blockchain.port';
import type { CrossChainProvider } from './cross-chain.port';
import type { FiatPayoutProvider } from './fiat-payout.port';

export const PROVIDER_ROLES: Record<string, (keyof ProviderRoleMap)[]> = {
  fireblocks: ['custody', 'blockchainExecution'],
  b2binpay: ['liquidity'],
  solanaRpc: ['blockchain'],
};
export interface ProviderRoleMap { custody: CustodyProvider; blockchainExecution: CustodyProvider; liquidity: LiquidityProvider; blockchain: BlockchainProvider; crossChain: CrossChainProvider; fiatPayout: FiatPayoutProvider; }
