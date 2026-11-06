/**
 * Asset registry (F6).
 *
 * An asset is identified by (network, contract), never by ticker alone. "USDC" is not an asset:
 * USDC on Solana mainnet and USDC on Ethereum are different contracts with different risk, and a
 * webhook that says "USDC" without a network cannot be attributed. Every settlement, deposit and
 * proof must carry an `AssetId` from this table; provider-specific ids (Fireblocks `USDC_SOL`)
 * are translated at the edge and never stored as the asset identity.
 *
 * Adding an asset or a network is a change here plus a Codex review — nothing else hard-codes
 * a mint. `src/providers/live/solana.ts` derives its mint table from this file.
 */
import { Prisma } from '@prisma/client';

export type NetworkId = 'solana-mainnet';
export type AssetId = 'USDC_SOL' | 'USDT_SOL';
export type ProviderName = 'fireblocks' | 'b2binpay';

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
  issuer: string;
  network: NetworkId;
  /** Token contract — the SPL mint on Solana. The identity of the asset together with `network`. */
  contract: string;
  decimals: number;
  /** How each provider names this exact asset. Absent = the provider does not support it. */
  providerIds: Partial<Record<ProviderName, string>>;
}

export const NETWORKS: Record<NetworkId, NetworkDefinition> = {
  'solana-mainnet': { id: 'solana-mainnet', family: 'solana', finality: 'finalized', explorerTx: s => `https://solscan.io/tx/${s}` },
};

export const ASSETS: Record<AssetId, AssetDefinition> = {
  USDC_SOL: {
    id: 'USDC_SOL', symbol: 'USDC', issuer: 'Circle', network: 'solana-mainnet',
    contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6,
    providerIds: { fireblocks: 'USDC_SOL', b2binpay: 'USDC-SOL' },
  },
  USDT_SOL: {
    id: 'USDT_SOL', symbol: 'USDT', issuer: 'Tether', network: 'solana-mainnet',
    contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6,
    providerIds: { fireblocks: 'USDT_SOL', b2binpay: 'USDT-SOL' },
  },
};

export class UnsupportedAssetError extends Error {
  readonly code = 'UNSUPPORTED_ASSET';
  constructor(detail: string) { super(`Unsupported asset: ${detail}`); }
}

export function getAsset(id: string): AssetDefinition {
  const a = (ASSETS as Record<string, AssetDefinition>)[id];
  if (!a) throw new UnsupportedAssetError(`unknown asset id '${id}'`);
  return a;
}

export function isAssetId(id: string): id is AssetId { return id in ASSETS; }

/** Resolve by the only true identity: network + contract. Returns null for a wrong network or a wrong contract. */
export function resolveByContract(network: string, contract: string): AssetDefinition | null {
  return Object.values(ASSETS).find(a => a.network === network && a.contract === contract) ?? null;
}

/** Translate a provider's asset id (e.g. Fireblocks `USDC_SOL`) into our asset. Null when the provider id is unknown or on an unsupported network. */
export function resolveProviderAsset(provider: ProviderName, providerAssetId: string | undefined | null): AssetDefinition | null {
  if (!providerAssetId) return null;
  return Object.values(ASSETS).find(a => a.providerIds[provider] === providerAssetId) ?? null;
}

export function providerAssetId(provider: ProviderName, asset: AssetId): string {
  const id = ASSETS[asset].providerIds[provider];
  if (!id) throw new UnsupportedAssetError(`${asset} is not supported by ${provider}`);
  return id;
}

/** Decimal amount → integer minor units. Throws if the amount carries more precision than the asset. */
export function toMinorUnits(amount: Prisma.Decimal.Value, asset: AssetDefinition): bigint {
  const d = new Prisma.Decimal(amount);
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
