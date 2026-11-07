/**
 * Asset registry (F6).
 *
 * AxLink is NOT an issuer. It settles existing, publicly issued stablecoins on a public network
 * (Solana mainnet). Nothing here creates, mints or redeems a token; it only names which public
 * tokens are accepted and how to recognise them.
 *
 * An asset is identified by (network, contract), never by ticker alone. "USDC" is not an asset:
 * USDC on Solana mainnet and USDC on Ethereum are different contracts with different risk, and a
 * webhook that says "USDC" without a network cannot be attributed. Every settlement, deposit and
 * proof must carry an `AssetId` from this table; provider-specific ids (Fireblocks `USDC_SOL`)
 * are translated at the edge and never stored as the asset identity.
 *
 * Adding an asset or a network is a change here plus a Codex review — nothing else hard-codes
 * a mint. The Solana RPC client derives its mint table from this file.
 *
 * One deployment serves ONE Solana cluster, chosen by SOLANA_CLUSTER (default `mainnet`):
 *   - mainnet: Circle USDC + Tether USDT, Fireblocks ids USDC_SOL / USDT_SOL (live workspace).
 *   - devnet:  Circle's devnet USDC (faucet.circle.com) for the Fireblocks sandbox / testnet
 *              workspace. Tether publishes no devnet USDT, so USDT is unsupported on devnet unless
 *              SOLANA_DEVNET_USDT_MINT names a test mint (scripts/devnet-test-usdt.ts creates one).
 *              Fireblocks names testnet assets per workspace: on devnet an asset is supported only
 *              when its FIREBLOCKS_*_ASSET is set too.
 * The AssetId (`USDC_SOL`) is the same on both clusters; the network + contract differ, so a devnet
 * token can never be attributed on a mainnet deployment and vice versa.
 */
import { Prisma } from '@prisma/client';

export type NetworkId = 'solana-mainnet' | 'solana-devnet';
export type AssetId = 'USDC_SOL' | 'USDT_SOL';
export type ProviderName = 'fireblocks' | 'b2binpay';
export type SolanaCluster = 'mainnet' | 'devnet';

export interface NetworkDefinition {
  id: NetworkId;
  family: 'solana';
  /** Finality rule the proof service enforces on this network. */
  finality: 'finalized';
  explorerTx: (sig: string) => string;
}

export interface AssetDefinition {
  id: AssetId;
  symbol: 'USDC' | 'USDT';
  /** Who issues the token on the public network (Circle, Tether). AxLink never issues or mints anything. */
  tokenIssuer: string;
  network: NetworkId;
  /** Token contract — the SPL mint on Solana. The identity of the asset together with `network`. */
  contract: string;
  decimals: number;
  supported: boolean;
  /** How each provider names this exact asset. Absent = the provider does not support it. */
  providerIds: Partial<Record<ProviderName, string>>;
}

export const NETWORKS: Record<NetworkId, NetworkDefinition> = {
  'solana-mainnet': { id: 'solana-mainnet', family: 'solana', finality: 'finalized', explorerTx: s => `https://solscan.io/tx/${s}` },
  'solana-devnet':  { id: 'solana-devnet',  family: 'solana', finality: 'finalized', explorerTx: s => `https://solscan.io/tx/${s}?cluster=devnet` },
};

/** The cluster this deployment settles on. Anything other than `devnet` is mainnet. */
export function solanaCluster(env: NodeJS.ProcessEnv = process.env): SolanaCluster {
  return (env.SOLANA_CLUSTER ?? 'mainnet').toLowerCase() === 'devnet' ? 'devnet' : 'mainnet';
}

/** The network every wallet, counterparty and proof on this deployment uses. */
export const ACTIVE_NETWORK: NetworkId = solanaCluster() === 'devnet' ? 'solana-devnet' : 'solana-mainnet';

/** Explorer link for a signature on this deployment's network (devnet links carry ?cluster=devnet). */
export const explorerTx = (sig: string): string => NETWORKS[ACTIVE_NETWORK].explorerTx(sig);

/** Public token contracts per cluster. Mainnet values are the issuers' canonical SPL mints. */
export const MINTS: Record<SolanaCluster, Record<AssetId, string | undefined>> = {
  mainnet: { USDC_SOL: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT_SOL: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  // Circle's devnet USDC. No official devnet USDT exists.
  devnet:  { USDC_SOL: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', USDT_SOL: process.env.SOLANA_DEVNET_USDT_MINT || undefined },
};

function fireblocksId(asset: AssetId, cluster: SolanaCluster): string | undefined {
  const override = asset === 'USDC_SOL' ? process.env.FIREBLOCKS_USDC_ASSET : process.env.FIREBLOCKS_USDT_ASSET; // same override the legacy services honour
  if (override) return override;
  return cluster === 'mainnet' ? asset : undefined; // testnet asset ids are workspace-specific: no guessing
}

export function buildAssets(cluster: SolanaCluster): Record<AssetId, AssetDefinition> {
  const network: NetworkId = cluster === 'devnet' ? 'solana-devnet' : 'solana-mainnet';
  const def = (id: AssetId, symbol: 'USDC' | 'USDT', tokenIssuer: string, b2binpay: string): AssetDefinition => {
    const contract = MINTS[cluster][id];
    const fireblocks = fireblocksId(id, cluster);
    return {
      // Mainnet: the canonical mint is enough. Devnet: the token must also be registered in the Fireblocks
      // sandbox (FIREBLOCKS_*_ASSET), or wallets could not be issued an address for it.
      id, symbol, tokenIssuer, network, contract: contract ?? '', decimals: 6, supported: Boolean(contract) && (cluster === 'mainnet' || Boolean(fireblocks)),
      // B2BinPay has no devnet: it is a later liquidity leg, and only ever mainnet.
      providerIds: { ...(fireblocks ? { fireblocks } : {}), ...(cluster === 'mainnet' ? { b2binpay } : {}) },
    };
  };
  return {
    USDC_SOL: def('USDC_SOL', 'USDC', 'Circle', 'USDC-SOL'),
    USDT_SOL: def('USDT_SOL', 'USDT', 'Tether', 'USDT-SOL'),
  };
}

export const ASSETS: Record<AssetId, AssetDefinition> = buildAssets(solanaCluster());

export class UnsupportedAssetError extends Error {
  readonly code = 'UNSUPPORTED_ASSET';
  constructor(detail: string) { super(`Unsupported asset: ${detail}`); }
}

export function getAsset(id: string): AssetDefinition {
  const a = Object.prototype.hasOwnProperty.call(ASSETS, id) ? (ASSETS as Record<string, AssetDefinition>)[id] : undefined;
  if (!a || !a.supported) throw new UnsupportedAssetError(`unknown asset id '${id}'`);
  return a;
}

export function isAssetId(id: string): id is AssetId { return Object.prototype.hasOwnProperty.call(ASSETS, id) && ASSETS[id as AssetId].supported; }

/** Resolve by the only true identity: network + contract. Returns null for a wrong network or a wrong contract. */
export function resolveByContract(network: string, contract: string): AssetDefinition | null {
  return Object.values(ASSETS).find(a => a.supported && a.network === network && a.contract === contract) ?? null;
}

/** Translate a provider's asset id (e.g. Fireblocks `USDC_SOL`) into our asset. Null when the provider id is unknown or on an unsupported network. */
export function resolveProviderAsset(provider: ProviderName, providerAssetId: string | undefined | null): AssetDefinition | null {
  if (!providerAssetId) return null;
  return Object.values(ASSETS).find(a => a.supported && a.providerIds[provider] === providerAssetId) ?? null;
}

export function providerAssetId(provider: ProviderName, asset: AssetId): string {
  const id = ASSETS[asset].providerIds[provider];
  if (!id) throw new UnsupportedAssetError(`${asset} is not supported by ${provider}`);
  return id;
}

/** Decimal amount → integer minor units. Throws if the amount carries more precision than the asset. */
export function toMinorUnits(amount: Prisma.Decimal.Value, asset: AssetDefinition): bigint {
  const d = new Prisma.Decimal(amount);
  if (!d.isFinite()) throw new RangeError('Asset amount must be finite');
  const scaled = d.mul(new Prisma.Decimal(10).pow(asset.decimals));
  if (!scaled.isInteger()) throw new RangeError(`${d.toString()} ${asset.symbol} has more than ${asset.decimals} decimals`);
  return BigInt(scaled.toFixed(0));
}

export function fromMinorUnits(raw: bigint, asset: AssetDefinition): Prisma.Decimal {
  return new Prisma.Decimal(raw.toString()).div(new Prisma.Decimal(10).pow(asset.decimals));
}

/** Assets by symbol for the places that still key on ticker (legacy custody accounts). Prefer `AssetId`. */
export function assetsForSymbol(symbol: string): AssetDefinition[] {
  return Object.values(ASSETS).filter(a => a.symbol === symbol.toUpperCase());
}

/**
 * The asset the legacy settlement-leg engine settles in when a flow does not say (USDC or USDT by
 * symbol). Per-wallet asset selection supersedes this for Leg A deposits; it remains for the
 * corridor engine until that is migrated.
 */
export const DEFAULT_SETTLEMENT_SYMBOL = (process.env.SETTLEMENT_ASSET ?? 'USDT').toUpperCase() as 'USDC' | 'USDT';
export function assetForSymbolOnNetwork(symbol: string, network: NetworkId = ACTIVE_NETWORK): AssetDefinition {
  const hit = Object.values(ASSETS).find(a => a.symbol === symbol.toUpperCase() && a.network === network);
  if (!hit) throw new UnsupportedAssetError(`${symbol} on ${network}`);
  return hit;
}
