/**
 * One deployment, one Solana cluster. devnet exists so the Fireblocks sandbox can be exercised end to
 * end with real (test) tokens; it must never leak into a mainnet deployment, and a configured
 * workspace must agree with the cluster or the app refuses to start.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

async function registryWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await import('../../packages/core/assets/registry'); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

afterEach(() => { vi.resetModules(); });

describe('asset registry per cluster', () => {
  it('defaults to mainnet: canonical mints, Fireblocks ids USDC_SOL/USDT_SOL', async () => {
    const r = await registryWith({ SOLANA_CLUSTER: undefined, FIREBLOCKS_USDC_ASSET: undefined, FIREBLOCKS_USDT_ASSET: undefined });
    expect(r.ACTIVE_NETWORK).toBe('solana-mainnet');
    expect(r.ASSETS.USDC_SOL).toMatchObject({ network: 'solana-mainnet', contract: MAINNET_USDC, supported: true, providerIds: { fireblocks: 'USDC_SOL', b2binpay: 'USDC-SOL' } });
    expect(r.ASSETS.USDT_SOL.supported).toBe(true);
  });

  it('devnet: Circle devnet USDC, the workspace\'s Fireblocks id, no B2BinPay, USDT unsupported without a test mint', async () => {
    const r = await registryWith({ SOLANA_CLUSTER: 'devnet', FIREBLOCKS_USDC_ASSET: 'USDC_SOL_DEVNET_X', SOLANA_DEVNET_USDT_MINT: undefined });
    expect(r.ACTIVE_NETWORK).toBe('solana-devnet');
    expect(r.ASSETS.USDC_SOL).toMatchObject({ network: 'solana-devnet', contract: DEVNET_USDC, supported: true, providerIds: { fireblocks: 'USDC_SOL_DEVNET_X' } });
    expect(r.ASSETS.USDC_SOL.providerIds.b2binpay).toBeUndefined();
    expect(r.ASSETS.USDT_SOL.supported).toBe(false);
    expect(r.isAssetId('USDT_SOL')).toBe(false);
    expect(r.resolveProviderAsset('fireblocks', 'USDC_SOL_DEVNET_X')?.id).toBe('USDC_SOL');
  });

  it('a mainnet token is never attributed on devnet, and a devnet token never on mainnet', async () => {
    const dev = await registryWith({ SOLANA_CLUSTER: 'devnet', FIREBLOCKS_USDC_ASSET: 'X' });
    expect(dev.resolveByContract('solana-devnet', MAINNET_USDC)).toBeNull();
    expect(dev.resolveByContract('solana-mainnet', MAINNET_USDC)).toBeNull(); // not this deployment's network
    expect(dev.resolveProviderAsset('fireblocks', 'USDC_SOL')).toBeNull();     // the live id means nothing here
    const main = await registryWith({ SOLANA_CLUSTER: 'mainnet', FIREBLOCKS_USDC_ASSET: undefined });
    expect(main.resolveByContract('solana-mainnet', DEVNET_USDC)).toBeNull();
    expect(main.resolveByContract('solana-devnet', DEVNET_USDC)).toBeNull();
  });

  it('devnet without FIREBLOCKS_USDC_ASSET has no Fireblocks id and USDC is not offered (no guessing a testnet id)', async () => {
    const r = await registryWith({ SOLANA_CLUSTER: 'devnet', FIREBLOCKS_USDC_ASSET: undefined });
    expect(r.ASSETS.USDC_SOL.providerIds.fireblocks).toBeUndefined();
    expect(r.ASSETS.USDC_SOL.supported).toBe(false);
    expect(() => r.providerAssetId('fireblocks', 'USDC_SOL')).toThrow(/not supported by fireblocks/);
  });

  it('devnet USDT-only sandbox: a test mint plus its Fireblocks id makes USDT_SOL the devnet asset', async () => {
    const r = await registryWith({ SOLANA_CLUSTER: 'devnet', FIREBLOCKS_USDC_ASSET: undefined, SOLANA_DEVNET_USDT_MINT: 'TestUsdtMint1111111111111111111111111111111', FIREBLOCKS_USDT_ASSET: 'AXLINK_TUSDT_X' });
    expect(r.ASSETS.USDT_SOL).toMatchObject({ network: 'solana-devnet', contract: 'TestUsdtMint1111111111111111111111111111111', supported: true, providerIds: { fireblocks: 'AXLINK_TUSDT_X' } });
    expect(r.isAssetId('USDC_SOL')).toBe(false);
    expect(r.resolveProviderAsset('fireblocks', 'AXLINK_TUSDT_X')?.id).toBe('USDT_SOL');
  });

  it('devnet explorer links carry the cluster', async () => {
    const r = await registryWith({});
    expect(r.NETWORKS['solana-devnet'].explorerTx('abc')).toBe('https://solscan.io/tx/abc?cluster=devnet');
  });
});

describe('workspace and cluster must agree', () => {
  const base = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://u@localhost/db', API_BASE_URL: 'http://localhost:4000/api' };
  const load = async (env: Record<string, string>) => { const { loadConfig } = await import('../../packages/shared/config'); return () => loadConfig(env as NodeJS.ProcessEnv); };

  it('no real Fireblocks key: no cluster constraint (stubbed custody)', async () => {
    expect(await load({ ...base, FIREBLOCKS_SANDBOX: 'true' })).not.toThrow();
    expect(await load({ ...base, FIREBLOCKS_API_KEY: 'your_api_key', SOLANA_CLUSTER: 'devnet' })).not.toThrow();
  });
  it('sandbox workspace on mainnet is refused', async () => {
    expect(await load({ ...base, FIREBLOCKS_API_KEY: 'k', FIREBLOCKS_SANDBOX: 'true' })).toThrow(/SOLANA_CLUSTER=devnet/);
  });
  it('live workspace on devnet is refused', async () => {
    expect(await load({ ...base, FIREBLOCKS_API_KEY: 'k', SOLANA_CLUSTER: 'devnet', FIREBLOCKS_USDC_ASSET: 'X' })).toThrow(/requires FIREBLOCKS_SANDBOX=true/);
  });
  it('devnet needs the workspace\'s USDC id and a devnet node', async () => {
    const env = { ...base, FIREBLOCKS_API_KEY: 'k', FIREBLOCKS_SANDBOX: 'true', SOLANA_CLUSTER: 'devnet' };
    expect(await load(env)).toThrow(/settlement asset registered in the Fireblocks sandbox/);
    process.env.SOLANA_DEVNET_USDT_MINT = 'TestUsdtMint1111111111111111111111111111111';
    try { expect(await load({ ...env, FIREBLOCKS_USDT_ASSET: 'AXLINK_TUSDT_X', SOLANA_RPC_URL: 'https://api.devnet.solana.com' })).not.toThrow(); }
    finally { delete process.env.SOLANA_DEVNET_USDT_MINT; }
    expect(await load({ ...env, FIREBLOCKS_USDC_ASSET: 'X', SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=z' })).toThrow(/looks like a mainnet node/);
    expect(await load({ ...env, FIREBLOCKS_USDC_ASSET: 'X', SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=z' })).not.toThrow();
  });
  it('production: the public Solana endpoint is refused on mainnet, allowed for the devnet sandbox', async () => {
    const prod = { ...base, NODE_ENV: 'production', OPS_API_KEY: 'k'.repeat(32), FIREBLOCKS_WORKSPACE_ID: 'w', FIREBLOCKS_API_KEY: 'k', WEBHOOK_ENCRYPTION_KEY: 'a'.repeat(64) };
    expect(await load({ ...prod, FIREBLOCKS_WEBHOOK_JWKS_URL: 'https://keys.fireblocks.io/.well-known/jwks.json', SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' })).toThrow(/dedicated node/);
    expect(await load({ ...prod, FIREBLOCKS_WEBHOOK_JWKS_URL: 'https://sandbox-keys.fireblocks.io/.well-known/jwks.json', FIREBLOCKS_SANDBOX: 'true', SOLANA_CLUSTER: 'devnet', FIREBLOCKS_USDC_ASSET: 'X', SOLANA_RPC_URL: 'https://api.devnet.solana.com' })).not.toThrow();
  });
  it('mainnet refuses a non-canonical Fireblocks asset override (a leftover testnet id)', async () => {
    expect(await load({ ...base, FIREBLOCKS_API_KEY: 'k', FIREBLOCKS_USDC_ASSET: 'USDC_SOL_TEST' })).toThrow(/FIREBLOCKS_USDC_ASSET unset or USDC_SOL/);
    expect(await load({ ...base, FIREBLOCKS_API_KEY: 'k', FIREBLOCKS_USDT_ASSET: 'X' })).toThrow(/FIREBLOCKS_USDT_ASSET unset or USDT_SOL/);
    expect(await load({ ...base, FIREBLOCKS_API_KEY: 'k', FIREBLOCKS_USDC_ASSET: 'USDC_SOL' })).not.toThrow();
  });
  it('mainnet with a devnet node is refused', async () => {
    expect(await load({ ...base, FIREBLOCKS_API_KEY: 'k', SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=z' })).toThrow(/looks like a devnet/);
  });
  it('production requires a Fireblocks API key', async () => {
    const prod = { ...base, NODE_ENV: 'production', OPS_API_KEY: 'k'.repeat(32), FIREBLOCKS_WORKSPACE_ID: 'w', FIREBLOCKS_WEBHOOK_JWKS_URL: 'https://keys.fireblocks.io/.well-known/jwks.json',  FIREBLOCKS_WEBHOOK_PUBLIC_KEY: 'p', WEBHOOK_ENCRYPTION_KEY: 'a'.repeat(64), SOLANA_RPC_URL: 'https://solana.dedicated.example/rpc' };
    expect(await load(prod)).toThrow(/FIREBLOCKS_API_KEY is required in production/);
    expect(await load({ ...prod, FIREBLOCKS_API_KEY: 'k' })).not.toThrow();
  });
  it('production verifies webhooks by JWKS only, from the workspace\'s own key set', async () => {
    const prod = { ...base, NODE_ENV: 'production', OPS_API_KEY: 'k'.repeat(32), FIREBLOCKS_WORKSPACE_ID: 'w', FIREBLOCKS_API_KEY: 'k', WEBHOOK_ENCRYPTION_KEY: 'a'.repeat(64), SOLANA_RPC_URL: 'https://solana.dedicated.example/rpc' };
    // the legacy static key alone no longer suffices: Fireblocks stopped sending that header
    expect(await load({ ...prod, FIREBLOCKS_WEBHOOK_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----x' })).toThrow(/FIREBLOCKS_WEBHOOK_JWKS_URL is required/);
    expect(await load({ ...prod, FIREBLOCKS_WEBHOOK_JWKS_URL: 'https://sandbox-keys.fireblocks.io/.well-known/jwks.json' })).toThrow(/does not match the workspace/);
    expect(await load({ ...prod, FIREBLOCKS_WEBHOOK_JWKS_URL: 'https://keys.fireblocks.io/.well-known/jwks.json' })).not.toThrow();
    const sbx = { ...prod, FIREBLOCKS_SANDBOX: 'true', SOLANA_CLUSTER: 'devnet', FIREBLOCKS_USDC_ASSET: 'X', SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=z' };
    expect(await load({ ...sbx, FIREBLOCKS_WEBHOOK_JWKS_URL: 'https://keys.fireblocks.io/.well-known/jwks.json' })).toThrow(/does not match the workspace/);
    expect(await load({ ...sbx, FIREBLOCKS_WEBHOOK_JWKS_URL: 'https://sandbox-keys.fireblocks.io/.well-known/jwks.json' })).not.toThrow();
    // a testnet workspace on an overridden API host: the JWKS pairing is left to the preflight
    process.env.FIREBLOCKS_BASE_URL = 'https://api.fireblocks.io/v1';
    try { expect(await load({ ...sbx, FIREBLOCKS_WEBHOOK_JWKS_URL: 'https://keys.fireblocks.io/.well-known/jwks.json' })).not.toThrow(); }
    finally { delete process.env.FIREBLOCKS_BASE_URL; }
  });
});
