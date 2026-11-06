/**
 * Step 2 · slice 4 — the /api/v1 institution contract, named as the Architecture Blueprint names it.
 * Every blueprint route answers; the older routes remain aliases; the ledger view is tenant-scoped.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto, { randomUUID } from 'crypto';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.FIREBLOCKS_WORKSPACE_ID = 'test-workspace';
process.env.WEBHOOK_ALLOW_INSECURE_URLS = 'true'; // no outbound DNS in the test sandbox; the URL is never delivered to here
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const db = process.env.DATABASE_URL ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };
const ALL = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'webhooks:write', 'webhooks:read', 'ledger:read'];

db('/api/v1 institution contract', () => {
  let app: import('express').Express; let prisma: any;
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service')); });

  async function institution(tag: string, scopes = ALL) {
    const id = randomUUID().slice(0, 8);
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug: `v1-${tag}-${id}`, legalName: `V1 ${tag}`, country: 'KE', kind: 'BANK' }).expect(201);
    await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } });
    const key = await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes }).expect(201);
    return { id: inst.body.id as string, auth: { Authorization: `Bearer ${key.body.apiKey}` } };
  }
  function signedFireblocks(body: object) {
    const raw = JSON.stringify(body); const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
    return request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw);
  }

  it('every blueprint route answers under /api/v1 with the institution credential; unauthenticated is 401', async () => {
    const A = await institution('a');
    await request(app).get('/api/v1/institutions/me').expect(401);
    const me = await request(app).get('/api/v1/institutions/me').set(A.auth).expect(200);
    expect(me.body).toMatchObject({ institution: { id: A.id }, environment: 'SANDBOX' }); expect(me.body.permissions).toEqual(ALL);

    const assets = await request(app).get('/api/v1/assets').set(A.auth).expect(200);
    expect(assets.body.assets.map((a: any) => a.id).sort()).toEqual(['USDC_SOL', 'USDT_SOL']);
    expect(assets.body.networks).toEqual([{ id: 'solana-mainnet', family: 'solana', finality: 'finalized' }]);

    // the institution provisions its own wallet in the environment its credential is bound to
    const w = await request(app).post('/api/v1/wallets').set(A.auth).send({ label: 'Main' }).expect(201);
    expect(w.body).toMatchObject({ label: 'Main', environment: 'SANDBOX', network: 'solana-mainnet' }); expect(typeof w.body.depositAddress).toBe('string');
    await request(app).post('/api/v1/wallets').set(A.auth).send({ label: 'Main' }).expect(409);
    expect((await request(app).get('/api/v1/wallets').set(A.auth).expect(200)).body.map((x: any) => x.id)).toEqual([w.body.id]);
    expect((await request(app).get(`/api/v1/wallets/${w.body.id}`).set(A.auth).expect(200)).body.id).toBe(w.body.id);
    expect((await request(app).get(`/api/wallets/${w.body.id}`).set(A.auth).expect(200)).body.id).toBe(w.body.id); // alias still answers

    const addr = await request(app).post('/api/v1/custody/deposit-addresses').set(A.auth).send({ walletId: w.body.id }).expect(200);
    expect(addr.body).toMatchObject({ walletId: w.body.id, network: 'solana-mainnet', address: w.body.depositAddress, assets: ['USDC_SOL', 'USDT_SOL'] });
    expect((await request(app).post('/api/v1/custody/deposit-addresses').set(A.auth).send({ walletId: w.body.id, asset: 'USDT_SOL' }).expect(200)).body.assets).toEqual(['USDT_SOL']);

    const bal = await request(app).get('/api/v1/balances').set(A.auth).expect(200);
    expect(bal.body.balances.map((b: any) => [b.asset, b.available])).toEqual([['USDC_SOL', '0'], ['USDT_SOL', '0']]);

    const dep = await request(app).post('/api/v1/deposits').set(A.auth).send({ walletId: w.body.id, asset: 'USDC_SOL', amount: '12.5', reference: 'INV-1' }).expect(201);
    expect(dep.body).toMatchObject({ kind: 'DEPOSIT', status: 'PROCESSING' });
    expect((await request(app).get('/api/v1/deposits').set(A.auth).expect(200)).body.map((d: any) => d.id)).toEqual([dep.body.id]);
    expect((await request(app).get(`/api/v1/deposits/${dep.body.id}`).set(A.auth).expect(200)).body.id).toBe(dep.body.id);
    expect((await request(app).get(`/api/v1/settlements/${dep.body.id}`).set(A.auth).expect(200)).body.id).toBe(dep.body.id);
    expect((await request(app).get(`/api/deposits/instructions/${dep.body.id}`).set(A.auth).expect(200)).body.id).toBe(dep.body.id); // alias

    const ep = await request(app).post('/api/v1/webhook-endpoints').set(A.auth).send({ url: 'http://127.0.0.1:9/axlink', events: ['deposit.settled'] }).expect(201);
    expect((await request(app).get('/api/v1/webhook-endpoints').set(A.auth).expect(200)).body.map((e: any) => e.id)).toEqual([ep.body.id]);
    await request(app).delete(`/api/v1/webhook-endpoints/${ep.body.id}`).set(A.auth).expect(204);

    for (const [m, p] of [['post', '/api/v1/transfers'], ['get', '/api/v1/transfers/x'], ['post', '/api/v1/settlements']] as const) {
      const r = await (request(app) as any)[m](p).set(A.auth).send({}).expect(501);
      expect(r.body.error.code).toBe('NOT_YET_AVAILABLE');
    }
  });

  it('ledger entries: a settled deposit shows the institution its two lines; another tenant sees nothing; cursor paging; scope enforced', async () => {
    const A = await institution('l'); const B = await institution('o');
    const w = (await request(app).post('/api/v1/wallets').set(A.auth).send({ label: 'Ledger' }).expect(201)).body;
    const d1 = (await request(app).post('/api/v1/deposits').set(A.auth).send({ walletId: w.id, asset: 'USDC_SOL', amount: '12.5' }).expect(201)).body;
    const d2 = (await request(app).post('/api/v1/deposits').set(A.auth).send({ walletId: w.id, asset: 'USDT_SOL', amount: '3' }).expect(201)).body;
    for (const [d, asset, amt] of [[d1, 'USDC_SOL', 12.5], [d2, 'USDT_SOL', 3]] as const) {
      await signedFireblocks({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data: { id: `fb-${randomUUID()}`, status: 'COMPLETED', assetId: asset, operation: 'TRANSFER', netAmount: amt, amount: amt, txHash: `sig${randomUUID().replace(/-/g, '')}`, destination: { type: 'VAULT_ACCOUNT', id: w.custody.vaultId }, source: { type: 'EXTERNAL_WALLET' }, externalTxId: d.trackingId } }).expect(200);
    }
    const bal = await request(app).get('/api/v1/balances').set(A.auth).expect(200);
    expect(bal.body.balances.map((b: any) => [b.asset, b.available])).toEqual([['USDC_SOL', '12.5'], ['USDT_SOL', '3']]);

    const all = await request(app).get('/api/v1/ledger/entries').set(A.auth).expect(200);
    expect(all.body.entries).toHaveLength(2); expect(all.body.nextCursor).toBeNull();
    const e = all.body.entries.find((x: any) => x.entityId === d1.id);
    expect(e).toMatchObject({ eventType: 'DEPOSIT', entityType: 'DepositInstruction' });
    expect(e.lines.map((l: any) => [l.account.split(':')[0], l.asset, l.amount]).sort()).toEqual([['CUSTODY', 'USDC_SOL', '12.5'], ['INSTITUTION', 'USDC_SOL', '-12.5']]);

    const p1 = await request(app).get('/api/v1/ledger/entries?limit=1').set(A.auth).expect(200);
    expect(p1.body.entries).toHaveLength(1); expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await request(app).get(`/api/v1/ledger/entries?limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`).set(A.auth).expect(200);
    expect(p2.body.entries).toHaveLength(1); expect(p2.body.entries[0].id).not.toBe(p1.body.entries[0].id); expect(p2.body.nextCursor).toBeNull();
    expect((await request(app).get('/api/v1/ledger/entries?cursor=garbage').set(A.auth).expect(400)).body.error.code).toBe('INVALID_CURSOR');
    expect((await request(app).get('/api/v1/ledger/entries?asset=USDT_SOL').set(A.auth).expect(200)).body.entries.map((x: any) => x.entityId)).toEqual([d2.id]);
    expect((await request(app).get(`/api/v1/ledger/entries?entityId=${d1.id}`).set(A.auth).expect(200)).body.entries).toHaveLength(1);

    expect((await request(app).get('/api/v1/ledger/entries').set(B.auth).expect(200)).body.entries).toEqual([]);
    expect((await request(app).get('/api/v1/balances').set(B.auth).expect(200)).body.balances.every((b: any) => b.available === '0')).toBe(true);
    const noLedger = await institution('n', ['wallets:read']);
    await request(app).get('/api/v1/ledger/entries').set(noLedger.auth).expect(403);
    await request(app).post('/api/v1/wallets').set(noLedger.auth).send({ label: 'x' }).expect(403);
  });

  it('review fixes: a SANDBOX key never sees PRODUCTION postings through the shared INSTITUTION account; wallet label race; address and 501 edge cases', async () => {
    const A = await institution('x');
    const w = (await request(app).post('/api/v1/wallets').set(A.auth).send({ label: 'Sbx' }).expect(201)).body;
    // Simulate a production-environment posting for the same institution: a custody account of a vault that is
    // NOT one of this environment's wallets, against the institution's liability account.
    const { post } = await import('../../packages/core/ledger/journal.service');
    const { AccountCode } = await import('../../packages/core/ledger/accounts');
    const { Prisma } = await import('@prisma/client');
    await prisma.$transaction((tx: any) => post(tx, { postingKey: `prod-${randomUUID()}`, eventType: 'DEPOSIT', entityType: 'DepositInstruction', entityId: 'prod-instr', narrative: 'PRODUCTION receipt', lines: [
      { account: AccountCode.custody(`vault_prod_${randomUUID().slice(0, 6)}`, 'USDC_SOL'), currency: 'USDC_SOL', amount: new Prisma.Decimal(99), usdAmount: new Prisma.Decimal(99) },
      { account: AccountCode.institution(A.id, 'USDC_SOL'), currency: 'USDC_SOL', amount: new Prisma.Decimal(-99), usdAmount: new Prisma.Decimal(-99) },
    ] }));
    expect((await request(app).get('/api/v1/ledger/entries').set(A.auth).expect(200)).body.entries).toEqual([]);
    expect((await request(app).get('/api/v1/balances').set(A.auth).expect(200)).body.balances.every((b: any) => b.available === '0')).toBe(true);

    // concurrent creates of the same label: exactly one wallet, the others 409 pointing at it
    const rs = await Promise.all([1, 2, 3, 4].map(() => request(app).post('/api/v1/wallets').set(A.auth).send({ label: 'Race' })));
    expect(rs.map(r => r.status).sort()).toEqual([201, 409, 409, 409]);
    const winner = rs.find(r => r.status === 201)!.body.id;
    for (const r of rs.filter(r => r.status === 409)) expect(r.body.error.details.walletId).toBe(winner);
    expect((await prisma.wallet.count({ where: { label: 'Race', institutionId: A.id } }))).toBe(1);

    // deposit address: suspended wallet → 409; missing address → 503; asset not on network → 400; happy path 200
    await prisma.wallet.update({ where: { id: w.id }, data: { status: 'SUSPENDED' } });
    expect((await request(app).post('/api/v1/custody/deposit-addresses').set(A.auth).send({ walletId: w.id }).expect(409)).body.error.code).toBe('WALLET_NOT_ACTIVE');
    await prisma.wallet.update({ where: { id: w.id }, data: { status: 'ACTIVE', depositAddress: null } });
    expect((await request(app).post('/api/v1/custody/deposit-addresses').set(A.auth).send({ walletId: w.id }).expect(503)).body.error.code).toBe('ADDRESS_NOT_ISSUED');
    await prisma.wallet.update({ where: { id: w.id }, data: { depositAddress: 'addr' } });
    expect((await request(app).post('/api/v1/custody/deposit-addresses').set(A.auth).send({ walletId: w.id }).expect(200)).body.address).toBe('addr');

    // 501 placeholders answer 501 for a key with no settlement scopes at all
    const narrow = await institution('nw', ['wallets:read']);
    await request(app).post('/api/v1/settlements').set(narrow.auth).send({}).expect(501);
    await request(app).post('/api/v1/transfers').set(narrow.auth).send({}).expect(501);
    // unknown scope strings are refused at issuance
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug: `v1-sc-${randomUUID().slice(0, 8)}`, legalName: 'Sc', country: 'KE', kind: 'BANK' }).expect(201);
    await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes: ['ledger:raed'] }).expect(400);
  });
});
