/**
 * Provider registry (Step 2, slice 3) — the one place core code obtains a provider.
 *
 *   providers.custody()            → the CustodyProvider for this deployment (Fireblocks)
 *   providers.liquidity()          → the LiquidityProvider (B2BinPay)
 *   providers.blockchain(network)  → the BlockchainProvider for a registry network (Solana)
 *
 * Adapters are registered at boot (apps/api/src/bootstrap/runtime.ts) and may be replaced for a
 * test or a different vendor; nothing under packages/core or packages/settlement imports a vendor
 * module. `describe()` is what the operator Providers screen shows.
 */
import type { CustodyProvider, LiquidityProvider, BlockchainProvider, ProviderHealth } from '../ports';
import type { NetworkId } from '../../core/assets/registry';
import { fireblocksCustodyProvider } from '../custody/fireblocks/fireblocks.custody-provider';
import { b2binpayLiquidityProvider } from '../liquidity/b2binpay/b2binpay.liquidity-provider';
import { solanaBlockchainProvider } from '../blockchain/solana/solana.blockchain-provider';

export type ProviderRole = 'custody' | 'blockchainExecution' | 'liquidity' | 'blockchain';

interface Registry { custody: CustodyProvider | null; liquidity: LiquidityProvider | null; blockchain: Partial<Record<NetworkId, BlockchainProvider>>; }
const reg: Registry = { custody: null, liquidity: null, blockchain: {} };

export class ProviderNotRegistered extends Error {
  readonly code = 'PROVIDER_NOT_REGISTERED';
  constructor(role: string) { super(`no ${role} provider is registered; register one at boot (bootstrap/runtime.ts)`); }
}

let defaultsLoaded = false;
/**
 * The deployment's default adapters (Fireblocks, B2BinPay, Solana). Loaded on first use so a
 * process that never called the bootstrap (tests importing the app) still has providers; the
 * bootstrap registers the same ones explicitly. Replace any of them with register*Provider.
 */
export function registerDefaultProviders(): void {
  if (defaultsLoaded) return; defaultsLoaded = true;
  reg.custody ??= fireblocksCustodyProvider; reg.liquidity ??= b2binpayLiquidityProvider; reg.blockchain['solana-mainnet'] ??= solanaBlockchainProvider;
}

export const providers = {
  custody(): CustodyProvider { if (!reg.custody) registerDefaultProviders(); if (!reg.custody) throw new ProviderNotRegistered('custody'); return reg.custody; },
  liquidity(): LiquidityProvider { if (!reg.liquidity) registerDefaultProviders(); if (!reg.liquidity) throw new ProviderNotRegistered('liquidity'); return reg.liquidity; },
  blockchain(network: NetworkId): BlockchainProvider { if (!reg.blockchain[network]) registerDefaultProviders(); const b = reg.blockchain[network]; if (!b) throw new ProviderNotRegistered(`blockchain:${network}`); return b; },
  has(role: 'custody' | 'liquidity'): boolean { return !!reg[role]; },
};

export function registerCustodyProvider(p: CustodyProvider | null): void { defaultsLoaded = true; reg.custody = p; }
export function registerLiquidityProvider(p: LiquidityProvider | null): void { reg.liquidity = p; }
export function registerBlockchainProvider(network: NetworkId, p: BlockchainProvider | null): void { if (p) reg.blockchain[network] = p; else delete reg.blockchain[network]; }

/** Snapshot for operators: who fills each role, whether credentials are configured, and live health. */
export async function describeProviders(opts: { health?: boolean } = {}): Promise<Array<{ role: ProviderRole; provider: string | null; network?: string; configured: boolean | null; health: ProviderHealth | null }>> {
  const out: Array<{ role: ProviderRole; provider: string | null; network?: string; configured: boolean | null; health: ProviderHealth | null }> = [];
  const h = async (p: { health(): Promise<ProviderHealth> } | null) => (opts.health && p ? p.health().catch(e => ({ ok: false, detail: (e as Error).message })) : null);
  const cfg = (health: ProviderHealth | null) => health ? !/sandbox stub/.test(health.detail ?? '') : null;
  const ch = await h(reg.custody);
  out.push({ role: 'custody', provider: reg.custody?.id ?? null, configured: cfg(ch), health: ch });
  out.push({ role: 'blockchainExecution', provider: reg.custody?.id ?? null, configured: cfg(ch), health: ch });
  const lh = await h(reg.liquidity);
  out.push({ role: 'liquidity', provider: reg.liquidity?.id ?? null, configured: cfg(lh), health: lh });
  for (const [network, b] of Object.entries(reg.blockchain)) {
    const bh = await h(b!);
    out.push({ role: 'blockchain', provider: b!.chain, network, configured: bh ? bh.ok : null, health: bh });
  }
  return out;
}
