/**
 * The published @axlink/sdk against the real API, over HTTP. Every request shape the SDK sends must be
 * one the API accepts, and every documented response field must be there — so the SDK cannot drift from
 * the API again (it had: transfers/deposits/counterparties sent field names the API rejects, and no
 * Idempotency-Key). Requires DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import crypto, { randomUUID } from 'crypto';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.FIREBLOCKS_WORKSPACE_ID = 'test-workspace';
process.env.WEBHOOK_ALLOW_INSECURE_URLS = 'true';
process.env.SIMULATOR_ENABLED = 'true';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const db = process.env.DATABASE_URL ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };
const SCOPES = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'webhooks:write', 'webhooks:read', 'ledger:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write'];

db('@axlink/sdk ↔ API contract', () => {
  let app: import('express').Express; let server: http.Server; let baseUrl: string;
  let sdk: typeof import('../../packages/sdk/src'); let svc: typeof import('../../packages/settlement/transfers/settlement-transfer.service');
  beforeAll(async () => {
    ({ app } = await import('../../apps/api/src/index'));
    sdk = await import('../../packages/sdk/src');
    svc = await import('../../packages/settlement/transfers/settlement-transfer.service');
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  async function bank(tag: string) {
    const slug = `sdk-${tag}-${randomUUID().slice(0, 8)}`;
    const inst = (await request(app).post('/api/institutions').set(ops).send({ slug, legalName: `SDK ${tag}`, country: 'KE', kind: 'BANK' }).expect(201)).body;
    await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'ACTIVE', reason: 'contract test' }).expect(200);
    const key = (await request(app).post(`/api/institutions/${inst.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'sdk', scopes: SCOPES }).expect(201)).body.apiKey;
    return { slug, client: new sdk.AxLinkClient({ baseUrl, apiKey: key }) };
  }

  it('onboard → wallet → deposit → network settlement → proof → ledger → webhooks, entirely through the SDK', async () => {
    const A = await bank('a'); const B = await bank('b');

    const me = await A.client.institutions.me();
    expect(me.environment).toBe('SANDBOX');
    const assets = await A.client.assets.list();
    expect(assets.assets.map(a => a.id).sort()).toEqual(['USDC_SOL', 'USDT_SOL']);

    const wallet = await A.client.wallets.create({ label: 'Treasury' });
    expect(wallet).toMatchObject({ label: 'Treasury', status: 'ACTIVE', custody: { provider: expect.any(String), vaultId: expect.any(String) } });
    await B.client.wallets.create({ label: 'Treasury' });
    const addr = await A.client.wallets.depositAddress({ walletId: wallet.id, asset: 'USDT_SOL' });
    expect(addr.assets).toEqual(['USDT_SOL']);

    // deposits.announce: the shape the API accepts
    const dep = await A.client.deposits.announce({ walletId: wallet.id, asset: 'USDT_SOL', amount: '500', reference: 'SDK-DEP' });
    expect(dep).toMatchObject({ kind: 'DEPOSIT', status: 'PROCESSING', asset: 'USDT_SOL', expectedAmount: '500', reference: 'SDK-DEP', trackingId: expect.stringMatching(/^dep_/) });
    const raw = JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data: { id: `fb-${randomUUID()}`, status: 'COMPLETED', assetId: 'USDT_SOL', operation: 'TRANSFER', netAmount: 500, amount: 500, txHash: `sig${randomUUID().replace(/-/g, '')}`, destination: { type: 'VAULT_ACCOUNT', id: wallet.custody.vaultId }, source: { type: 'EXTERNAL_WALLET' }, externalTxId: dep.trackingId } });
    await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64') }).send(raw).expect(200);
    expect((await A.client.deposits.get(dep.id)).receivedAmount).toBe('500');

    // counterparties.create: another bank on the network, by slug
    const cp = await A.client.counterparties.create({ label: 'SDK B', participant: B.slug });
    expect(cp).toMatchObject({ kind: 'NETWORK', participant: B.slug, address: null });

    // settlements.create: Idempotency-Key header; a retry returns the same settlement and never pays twice
    const params = { walletId: wallet.id, counterpartyId: cp.id, asset: 'USDT_SOL' as const, amount: '120', reference: 'INV-SDK-1', idempotencyKey: `inv-${randomUUID()}` };
    const s1 = await A.client.settlements.create(params);
    const s2 = await A.client.settlements.create(params);
    expect(s2.id).toBe(s1.id);
    expect(s1).toMatchObject({ kind: 'TRANSFER', asset: 'USDT_SOL', amount: '120', reference: 'INV-SDK-1', idempotencyKey: params.idempotencyKey, walletId: wallet.id });
    await svc.runTransferSweep();
    const done = await A.client.transfers.get(s1.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.proof).toMatchObject({ finality: expect.any(String) });
    expect((await A.client.settlements.get(s1.id)).status).toBe('COMPLETED');
    expect((await A.client.transfers.list()).map(t => t.id)).toContain(s1.id);

    // an external address via transfers.create
    const ext = await A.client.counterparties.create({ label: 'Cold wallet', address: crypto.randomBytes(32).toString('hex').replace(/[0lIO]/g, 'a').slice(0, 44) });
    expect(ext).toMatchObject({ kind: 'EXTERNAL', participant: null });
    const t = await A.client.transfers.create({ walletId: wallet.id, counterpartyId: ext.id, asset: 'USDT_SOL', amount: '30', idempotencyKey: `ext-${randomUUID()}` });
    expect(t.amount).toBe('30');

    // ledger + webhooks
    const ledger = await A.client.ledger.entries({ entityId: s1.id });
    expect(ledger.entries.length).toBeGreaterThan(0);
    const hook = await A.client.webhooks.create({ url: 'http://127.0.0.1:9/hook', events: ['transfer.settled', 'deposit.settled'] });
    expect(hook.secret).toEqual(expect.any(String));
    expect((await A.client.webhooks.list()).map(e => e.id)).toContain(hook.id);
  });

  it('errors arrive as AxLinkError with the API code; a missing idempotency key is refused before any request', async () => {
    const A = await bank('err');
    const w = await A.client.wallets.create({ label: 'W' });
    await expect(A.client.transfers.create({ walletId: w.id, counterpartyId: 'nope', asset: 'USDT_SOL', amount: '1', idempotencyKey: '' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(A.client.deposits.announce({ walletId: w.id, asset: 'USDT_SOL', amount: '1.1234567' }))
      .rejects.toBeInstanceOf(sdk.AxLinkError);
    const bad = new sdk.AxLinkClient({ baseUrl, apiKey: 'axlk_test_invalidinvalidinvalidinv' });
    await expect(bad.institutions.me()).rejects.toMatchObject({ statusCode: 401 });
  });
});
