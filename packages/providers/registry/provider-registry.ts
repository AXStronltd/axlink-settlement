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
import type { CustodyProvider, LiquidityProvider, BlockchainProvider, ProviderHealth, ScreeningProvider } from '../ports';
import { ACTIVE_NETWORK, type NetworkId } from '../../core/assets/registry';
import { fireblocksCustodyProvider } from '../custody/fireblocks/fireblocks.custody-provider';
import { b2binpayLiquidityProvider } from '../liquidity/b2binpay/b2binpay.liquidity-provider';
import { stubScreeningProvider } from '../screening/stub/stub.screening-provider';
import { solanaBlockchainProvider } from '../blockchain/solana/solana.blockchain-provider';

export type ProviderRole = 'custody' | 'blockchainExecution' | 'liquidity' | 'blockchain' | 'screening';

interface Registry { custody: CustodyProvider | null; liquidity: LiquidityProvider | null; screening: ScreeningProvider | null; blockchain: Partial<Record<NetworkId, BlockchainProvider>>; }
const reg: Registry = { custody: null, liquidity: null, screening: null, blockchain: {} };

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
  reg.custody ??= fireblocksCustodyProvider; reg.liquidity ??= b2binpayLiquidityProvider; reg.screening ??= stubScreeningProvider; reg.blockchain[ACTIVE_NETWORK] ??= solanaBlockchainProvider;
}

export const providers = {
  custody(): CustodyProvider { if (!reg.custody) registerDefaultProviders(); if (!reg.custody) throw new ProviderNotRegistered('custody'); return reg.custody; },
  liquidity(): LiquidityProvider { if (!reg.liquidity) registerDefaultProviders(); if (!reg.liquidity) throw new ProviderNotRegistered('liquidity'); return reg.liquidity; },
  screening(): ScreeningProvider { if (!reg.screening) registerDefaultProviders(); if (!reg.screening) throw new ProviderNotRegistered('screening'); return reg.screening; },
  blockchain(network: NetworkId): BlockchainProvider { if (!reg.blockchain[network]) registerDefaultProviders(); const b = reg.blockchain[network]; if (!b) throw new ProviderNotRegistered(`blockchain:${network}`); return b; },
  has(role: 'custody' | 'liquidity' | 'screening'): boolean { return !!reg[role]; },
};

export class ProviderReplacementRefused extends Error {
  readonly code = 'PROVIDER_REPLACEMENT_REFUSED';
  constructor(reason: string) { super(`refusing to replace a registered provider after boot: ${reason}`); }
}

let frozen = false;
/**
 * Called by the bootstrap once the deployment's adapters are registered. From then on a
 * replacement is refused in production, and elsewhere only allowed with SIMULATOR_ENABLED=true —
 * the same rule as the runtime seam (`useTestPorts`). A stray `registerCustodyProvider({...,
 * configured: () => true})` would otherwise flip `custodyEnvironmentKind()` to PRODUCTION and let
 * stub vault ids be persisted as production wallets.
 */
export function freezeProviders(): void { frozen = true; }
function assertReplaceable(): void {
  if (!frozen) return;
  if (process.env.NODE_ENV === 'production') throw new ProviderReplacementRefused('NODE_ENV is production');
  if (process.env.SIMULATOR_ENABLED !== 'true') throw new ProviderReplacementRefused('SIMULATOR_ENABLED is not "true"');
}

export function registerCustodyProvider(p: CustodyProvider | null): void { assertReplaceable(); defaultsLoaded = true; reg.custody = p; }
export function registerLiquidityProvider(p: LiquidityProvider | null): void { assertReplaceable(); reg.liquidity = p; }
export function registerScreeningProvider(p: ScreeningProvider | null): void { assertReplaceable(); reg.screening = p; }
export function registerBlockchainProvider(network: NetworkId, p: BlockchainProvider | null): void { assertReplaceable(); if (p) reg.blockchain[network] = p; else delete reg.blockchain[network]; }

const HEALTH_TIMEOUT_MS = 5_000;
function withTimeout(p: Promise<ProviderHealth>, ms = HEALTH_TIMEOUT_MS): Promise<ProviderHealth> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<ProviderHealth>(res => { t = setTimeout(() => res({ ok: false, detail: `health check timed out after ${ms}ms` }), ms); });
  return Promise.race([p.catch(e => ({ ok: false, detail: (e as Error).message })), timeout]).finally(() => clearTimeout(t));
}

/**
 * Snapshot for operators: who fills each role, whether credentials are configured, and live health.
 * `configured` comes from the adapter itself; health calls run in parallel, each bounded by a
 * timeout so a hung vendor cannot hold the operator request open.
 */
export async function describeProviders(opts: { health?: boolean } = {}): Promise<Array<{ role: ProviderRole; provider: string | null; network?: string; configured: boolean | null; health: ProviderHealth | null }>> {
  registerDefaultProviders();
  const h = (p: { health(): Promise<ProviderHealth> } | null) => (opts.health && p ? withTimeout(p.health()) : Promise.resolve(null));
  const chains = Object.entries(reg.blockchain) as Array<[string, BlockchainProvider]>;
  const [ch, lh, sh, ...bhs] = await Promise.all([h(reg.custody), h(reg.liquidity), h(reg.screening), ...chains.map(([, b]) => h(b))]);
  const custodyConfigured = reg.custody ? reg.custody.configured() : null;
  return [
    { role: 'custody', provider: reg.custody?.id ?? null, configured: custodyConfigured, health: ch },
    { role: 'blockchainExecution', provider: reg.custody?.id ?? null, configured: custodyConfigured, health: ch },
    { role: 'liquidity', provider: reg.liquidity?.id ?? null, configured: reg.liquidity ? reg.liquidity.configured() : null, health: lh },
    { role: 'screening', provider: reg.screening?.id ?? null, configured: reg.screening ? reg.screening.configured() : null, health: sh },
    ...chains.map(([network, b], i) => ({ role: 'blockchain' as const, provider: b.chain, network, configured: bhs[i] ? bhs[i]!.ok : null, health: bhs[i] })),
  ];
}
