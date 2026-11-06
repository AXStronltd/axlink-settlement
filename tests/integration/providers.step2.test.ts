/**
 * Step 2 · slice 3 — providers on the ports. Fireblocks, B2BinPay and Solana are adapters behind
 * the port interfaces, obtained from the registry; swapping one changes nothing in core.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.SIMULATOR_ENABLED = 'true';

const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };
const db = process.env.DATABASE_URL ? describe : describe.skip;

describe('adapters conform to the ports (sandbox mode, no credentials)', () => {
  it('Fireblocks adapter: vault + address + balance + transfer status mapping, parse of a deposit webhook', async () => {
    const { fireblocksCustodyProvider: fb } = await import('../../packages/providers/custody/fireblocks/fireblocks.custody-provider');
    expect(fb.id).toBe('fireblocks'); expect(fb.configured()).toBe(false);
    const v = await fb.createVault('Test', 'inst:SANDBOX:Test'); expect(v.vaultId).toMatch(/^vault_sbx_/);
    const a = await fb.getDepositAddress(v.vaultId, { symbol: 'USDC', chain: 'solana-mainnet' }); expect(typeof a.address).toBe('string');
    const b = await fb.getBalance(v.vaultId, { symbol: 'USDT', chain: 'solana-mainnet' }); expect(b).toEqual({ available: '0', pending: '0' });
    await expect(fb.getDepositAddress(v.vaultId, { symbol: 'USDC', chain: 'ethereum-mainnet' })).rejects.toThrow(/not in the registry/);
    const t = await fb.transferInternal({ clientRef: 'x', fromVaultId: 'a', toVaultId: 'b', asset: { symbol: 'USDT', chain: 'solana-mainnet' }, amount: '1' });
    expect(t.providerTxId).toMatch(/_sandbox_/); expect(['PENDING', 'CONFIRMED']).toContain(t.status);
    const parsed = fb.parseWebhook({ rawBody: JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', data: { id: 'fb1', status: 'COMPLETED', assetId: 'USDC_SOL', operation: 'TRANSFER', txHash: 'sig1', netAmount: 5, destination: { type: 'VAULT_ACCOUNT', id: 'v1' } } }), headers: {} });
    expect(parsed).toEqual({ kind: 'DEPOSIT', vaultId: 'v1', asset: { symbol: 'USDC', chain: 'solana-mainnet' }, amount: '5', txHash: 'sig1' });
    expect(fb.parseWebhook({ rawBody: 'not json', headers: {} })).toEqual({ kind: 'IGNORED' });
    expect(fb.verifyWebhook({ rawBody: '{}', headers: {} })).toBe(false); // unconfigured → never verifies
    expect((await fb.health()).ok).toBe(true);
  });
  it('B2BinPay adapter: pairs, webhook parse, health; Solana adapter: address validation, health shape', async () => {
    const { b2binpayLiquidityProvider: lp } = await import('../../packages/providers/liquidity/b2binpay/b2binpay.liquidity-provider');
    expect(lp.id).toBe('b2binpay'); expect(lp.pairs.length).toBeGreaterThan(0);
    expect(lp.parseWebhook({ rawBody: JSON.stringify({ data: { id: 't1', attributes: { status: 2, tracking_id: 'out_1', amount: '3' } } }), headers: {} })).toMatchObject({ kind: 'ORDER_STATUS', clientRef: 'out_1' });
    expect(lp.verifyWebhook({ rawBody: '{}', headers: {} })).toBe(false);
    expect((await lp.health()).ok).toBe(true);
    const { solanaBlockchainProvider: sol } = await import('../../packages/providers/blockchain/solana/solana.blockchain-provider');
    expect(sol.chain).toBe('solana-mainnet');
    expect(sol.isValidAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true); expect(sol.isValidAddress('0xabc')).toBe(false);
  });
});

describe('registry', () => {
  afterEach(async () => {
    const r = await import('../../packages/providers/registry/provider-registry');
    const { fireblocksCustodyProvider } = await import('../../packages/providers/custody/fireblocks/fireblocks.custody-provider');
    r.registerCustodyProvider(fireblocksCustodyProvider);
  });
  it('hands out the defaults, describes every role, and a replaced adapter is what core code gets', async () => {
    const r = await import('../../packages/providers/registry/provider-registry');
    expect(r.providers.custody().id).toBe('fireblocks'); expect(r.providers.liquidity().id).toBe('b2binpay'); expect(r.providers.blockchain('solana-mainnet').chain).toBe('solana-mainnet');
    const d = await r.describeProviders({ health: true });
    expect(d.map(x => x.role)).toEqual(['custody', 'blockchainExecution', 'liquidity', 'blockchain']);
    expect(d.find(x => x.role === 'custody')).toMatchObject({ provider: 'fireblocks', configured: false });
    expect(d.find(x => x.role === 'blockchain')).toMatchObject({ provider: 'solana-mainnet', network: 'solana-mainnet' });
    const fake = { ...r.providers.custody(), id: 'acme-custody', configured: () => false, createVault: async () => ({ vaultId: `acme-${randomUUID().slice(0, 8)}` }), getDepositAddress: async () => ({ address: 'acme-addr' }) };
    r.registerCustodyProvider(fake);
    expect(r.providers.custody().id).toBe('acme-custody');
  });
});

db('core reaches custody only through the registry (wallet creation on a swapped adapter)', () => {
  let app: import('express').Express; let prisma: any;
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service')); });
  afterEach(async () => {
    const r = await import('../../packages/providers/registry/provider-registry');
    const { fireblocksCustodyProvider } = await import('../../packages/providers/custody/fireblocks/fireblocks.custody-provider');
    r.registerCustodyProvider(fireblocksCustodyProvider);
  });
  it('a wallet created while a different custody adapter is registered carries that adapter id and its address', async () => {
    const r = await import('../../packages/providers/registry/provider-registry');
    const id = randomUUID().slice(0, 8);
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug: `prov-${id}`, legalName: 'Prov Test', country: 'KE', kind: 'BANK' }).expect(201);
    await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } });
    r.registerCustodyProvider({ ...r.providers.custody(), id: 'acme-custody', configured: () => false, createVault: async () => ({ vaultId: `acme-${id}` }), getDepositAddress: async () => ({ address: `acme-addr-${id}` }) });
    const w = await request(app).post(`/api/institutions/${inst.body.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'Swapped' }).expect(201);
    expect(w.body.custody).toEqual({ provider: 'acme-custody', vaultId: `acme-${id}` }); expect(w.body.depositAddress).toBe(`acme-addr-${id}`);
  });
  it('GET /api/settlement/providers is operator-only and lists roles with health', async () => {
    await request(app).get('/api/settlement/providers').expect(401);
    const r = await request(app).get('/api/settlement/providers').set(ops).expect(200);
    expect(r.body.providers.map((p: any) => [p.role, p.provider])).toEqual([['custody', 'fireblocks'], ['blockchainExecution', 'fireblocks'], ['liquidity', 'b2binpay'], ['blockchain', 'solana-mainnet']]);
    expect(r.body.providers[0].health.ok).toBe(true);
  });
  it('proof service goes through the blockchain port: a stubbed node proves a settlement for USDC_SOL by id or by symbol', async () => {
    const { useTestPorts } = await import('../../packages/providers/ports/runtime');
    const { proveSettlement } = await import('../../packages/settlement/proof/proof.service');
    const { ASSETS } = await import('../../packages/core/assets/registry');
    const sig = `sig-${randomUUID()}`;
    const restore = useTestPorts({ chain: {
      awaitFinality: async (s: string) => ({ signature: s, found: true, slot: 77, confirmations: null, commitment: 'finalized', err: null }),
      getTransaction: async (s: string) => ({ signature: s, slot: 77, blockTime: new Date(), feeLamports: 5000n, err: null, tokenTransfers: [{ mint: ASSETS.USDC_SOL.contract, owner: null, decimals: 6, changeRaw: 1_000_000n }] }),
    } as any });
    try {
      const r = await proveSettlement({ entityType: 'Test', entityId: sig, signature: sig, asset: 'USDC_SOL', expectedAmount: '1' });
      expect(r.status).toBe('PROVEN'); expect(r.proof?.mint).toBe(ASSETS.USDC_SOL.contract);
      const again = await proveSettlement({ entityType: 'Test', entityId: sig, signature: sig, asset: 'USDC', expectedAmount: '1' });
      expect(again.status).toBe('ALREADY_PROVEN');
      await expect(proveSettlement({ entityType: 'Test', entityId: 'x', signature: `sig-${randomUUID()}`, asset: 'USDC_SOL', expectedAmount: '2' })).rejects.toThrow(/mismatch/);
    } finally { restore(); }
  });
});
