/**
 * Step 2 · slice 2 — deposit instructions on wallets, settlement status with proof, signed
 * institution webhooks. Requires DATABASE_URL. Fireblocks events are signed with a test RSA key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import crypto, { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.FIREBLOCKS_WORKSPACE_ID = 'test-workspace';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const db = process.env.DATABASE_URL ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };

db('deposit instructions, settlement status, institution webhooks', () => {
  let app: import('express').Express; let prisma: any;
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let hookServer: http.Server; let hookUrl: string; let hookStatus = 200;
  beforeAll(async () => {
    ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service'));
    hookServer = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.statusCode = hookStatus; res.end(); }); });
    await new Promise<void>(r => hookServer.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hookServer.address() as { port: number }).port}/hook`;
  });
  afterAll(() => hookServer.close());

  async function institution(tag: string, scopes = ['wallets:read', 'deposits:write', 'deposits:read', 'settlements:read', 'webhooks:write', 'webhooks:read']) {
    const id = randomUUID().slice(0, 8);
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug: `s-${tag}-${id}`, legalName: `Settle ${tag}`, country: 'KE', kind: 'BANK' }).expect(201);
    await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } });
    const key = await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes }).expect(201);
    const w = await request(app).post(`/api/institutions/${inst.body.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'Main' }).expect(201);
    return { id: inst.body.id as string, auth: { Authorization: `Bearer ${key.body.apiKey}` }, wallet: w.body };
  }
  function fbEvent(instr: any, vaultId: string, over: Record<string, unknown> = {}) {
    return { type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data: { id: `fb-${randomUUID()}`, status: 'COMPLETED', assetId: 'USDC_SOL', operation: 'TRANSFER', netAmount: 12.5, amount: 12.5, txHash: `sig${randomUUID().replace(/-/g, '')}`, destination: { type: 'VAULT_ACCOUNT', id: vaultId }, source: { type: 'EXTERNAL_WALLET' }, externalTxId: instr.trackingId, ...over } };
  }
  function signedPost(body: object) {
    const raw = JSON.stringify(body); const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
    return request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw);
  }

  it('an instruction returns the wallet deposit address and a tracking id; it is PROCESSING until the receipt', async () => {
    const A = await institution('create');
    const r = await request(app).post('/api/deposits/instructions').set(A.auth).send({ walletId: A.wallet.id, asset: 'USDC_SOL', amount: '12.5', reference: 'INV-1' }).expect(201);
    expect(r.body).toMatchObject({ kind: 'DEPOSIT', status: 'PROCESSING', instructionStatus: 'PENDING', asset: 'USDC_SOL', expectedAmount: '12.5', reference: 'INV-1', depositAddress: A.wallet.depositAddress, proof: null });
    expect(r.body.trackingId).toMatch(/^dep_/);
    const s = await request(app).get(`/api/settlements/${r.body.id}`).set(A.auth).expect(200);
    expect(s.body.status).toBe('PROCESSING');
    // validation
    await request(app).post('/api/deposits/instructions').set(A.auth).send({ walletId: A.wallet.id, asset: 'USDC_SOL', amount: '0.0000001' }).expect(400);
    await request(app).post('/api/deposits/instructions').set(A.auth).send({ walletId: A.wallet.id, asset: 'USDC_ETH', amount: '1' }).expect(400);
    await request(app).post('/api/deposits/instructions').set(A.auth).send({ walletId: 'nope', asset: 'USDC_SOL', amount: '1' }).expect(404);
  });

  it('a signed custody receipt naming the instruction settles it: journal, wallet balance, status COMPLETED with proof, webhook delivered with the documented signature', async () => {
    const A = await institution('settle');
    const ep = await request(app).post('/api/webhooks/endpoints').set(A.auth).send({ url: hookUrl }).expect(201);
    expect(ep.body.secret).toMatch(/^whsec_/);
    expect((await prisma.webhookEndpoint.findUnique({ where: { id: ep.body.id } })).secretCiphertext).toMatch(/^enc:v1:/); // never plaintext at rest
    const instr = (await request(app).post('/api/deposits/instructions').set(A.auth).send({ walletId: A.wallet.id, asset: 'USDC_SOL', amount: '12.5', reference: 'INV-2' }).expect(201)).body;
    const ev = fbEvent(instr, A.wallet.custody.vaultId);
    const r = await signedPost(ev).expect(200);
    expect(r.body.outcome).toBe('PROCESSED');

    const s = await request(app).get(`/api/settlements/${instr.id}`).set(A.auth).expect(200);
    expect(s.body).toMatchObject({ status: 'COMPLETED', instructionStatus: 'SETTLED', receivedAmount: '12.5' });
    expect(s.body.proof).toMatchObject({ custodyTxId: ev.data.id, txHash: ev.data.txHash, explorerUrl: `https://solscan.io/tx/${ev.data.txHash}`, finality: 'CUSTODY_CONFIRMED' });
    const bal = (await request(app).get(`/api/wallets/${A.wallet.id}/balances`).set(A.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL');
    expect(bal.available).toBe('12.5'); expect(bal.drift).toBe(false);
    const lines = await prisma.journalLine.findMany({ where: { entry: { entityType: 'DepositInstruction', entityId: instr.id } }, include: { account: true } });
    expect(lines.map((l: any) => [l.account.code.split(':')[0], l.amount.toString()]).sort()).toEqual([['CUSTODY', '12.5'], ['INSTITUTION', '-12.5']]);
    const evRow = await prisma.providerEvent.findUnique({ where: { provider_eventId: { provider: 'fireblocks', eventId: `${ev.data.id}:COMPLETED` } } });
    expect(evRow).toMatchObject({ status: 'PROCESSED', institutionId: A.id, walletId: A.wallet.id, entityType: 'DepositInstruction', entityId: instr.id });

    // replay → duplicate, nothing moves
    expect((await signedPost(ev).expect(200)).body.duplicate).toBe(true);
    expect((await request(app).get(`/api/wallets/${A.wallet.id}/balances`).set(A.auth)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('12.5');

    // webhook: one outbox row, delivered with t=…,v1=… over the exact body, and an event id
    const { drain } = await import('../../packages/core/events/outbox.service');
    received.length = 0; await drain();
    const hit = received.find(h => h.body.includes(instr.id));
    expect(hit).toBeTruthy();
    const payload = JSON.parse(hit!.body);
    expect(payload).toMatchObject({ type: 'deposit.settled', data: { settlementId: instr.id, status: 'COMPLETED', amount: '12.5', reference: 'INV-2', asset: 'USDC_SOL' } });
    expect(hit!.headers['x-axlink-event-id']).toBe(payload.id);
    const sig = String(hit!.headers['x-axlink-signature']); const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    expect(m).toBeTruthy();
    expect(crypto.createHmac('sha256', ep.body.secret).update(`${m![1]}.${hit!.body}`).digest('hex')).toBe(m![2]);
  });

  it('wrong amount, wrong asset, wrong vault, expired or cancelled instruction never credit', async () => {
    const A = await institution('reject'); const B = await institution('reject2');
    const mk = async (over: Record<string, unknown> = {}) => (await request(app).post('/api/deposits/instructions').set(A.auth).send({ walletId: A.wallet.id, asset: 'USDC_SOL', amount: '12.5', ...over }).expect(201)).body;
    const bal = async () => (await request(app).get(`/api/wallets/${A.wallet.id}/balances`).set(A.auth)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available;
    const i1 = await mk(); await signedPost(fbEvent(i1, A.wallet.custody.vaultId, { netAmount: 12.4, amount: 12.4 })).expect(200);
    const i2 = await mk(); await signedPost(fbEvent(i2, A.wallet.custody.vaultId, { assetId: 'USDT_SOL' })).expect(200);
    const i3 = await mk(); await signedPost(fbEvent(i3, B.wallet.custody.vaultId)).expect(200); // landed in B's vault
    const i4 = await mk(); await request(app).post(`/api/deposits/instructions/${i4.id}/cancel`).set(A.auth).expect(200); await signedPost(fbEvent(i4, A.wallet.custody.vaultId)).expect(200);
    const i5 = await mk(); await prisma.depositInstruction.update({ where: { id: i5.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); await signedPost(fbEvent(i5, A.wallet.custody.vaultId)).expect(200);
    const i6 = await mk(); await signedPost(fbEvent(i6, A.wallet.custody.vaultId, { source: { type: 'VAULT_ACCOUNT', id: B.wallet.custody.vaultId } })).expect(200); // internal move
    expect(await bal()).toBe('0');
    expect((await request(app).get(`/api/wallets/${B.wallet.id}/balances`).set(B.auth)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('0');
    for (const i of [i1, i2, i3, i6]) expect((await prisma.depositInstruction.findUnique({ where: { id: i.id } })).status).toBe('PENDING');
    const rej = await prisma.providerEvent.findMany({ where: { entityId: { in: [i1.id, i2.id, i3.id, i4.id, i5.id, i6.id] } } });
    expect(rej.every((r: any) => r.status !== 'PROCESSED')).toBe(true);
    expect(rej.find((r: any) => r.entityId === i1.id).reason).toMatch(/differs from instructed/);
    expect(rej.find((r: any) => r.entityId === i3.id).reason).toMatch(/different vault/);
  });

  it('ten concurrent copies of one receipt settle the instruction exactly once', async () => {
    const A = await institution('conc');
    const instr = (await request(app).post('/api/deposits/instructions').set(A.auth).send({ walletId: A.wallet.id, asset: 'USDT_SOL', amount: '3' }).expect(201)).body;
    const ev = fbEvent(instr, A.wallet.custody.vaultId, { assetId: 'USDT_SOL', netAmount: 3, amount: 3 });
    const rs = await Promise.all(Array.from({ length: 10 }, () => signedPost(ev)));
    expect(rs.every(r => r.status === 200)).toBe(true);
    expect(rs.filter(r => r.body.duplicate !== true).length).toBe(1);
    expect((await request(app).get(`/api/wallets/${A.wallet.id}/balances`).set(A.auth)).body.balances.find((b: any) => b.asset === 'USDT_SOL').available).toBe('3');
    expect(await prisma.outboxEvent.count({ where: { entityType: 'DepositInstruction', entityId: instr.id } })).toBe(0); // no endpoint registered → nothing queued
  });

  it('isolation: another institution cannot read, cancel or settle my instruction; scopes enforced; webhook endpoints are per environment', async () => {
    const A = await institution('iso'); const B = await institution('iso2'); const noScope = await institution('iso3', ['wallets:read']);
    const instr = (await request(app).post('/api/deposits/instructions').set(A.auth).send({ walletId: A.wallet.id, asset: 'USDC_SOL', amount: '1' }).expect(201)).body;
    await request(app).get(`/api/settlements/${instr.id}`).set(B.auth).expect(404);
    await request(app).get(`/api/deposits/instructions/${instr.id}`).set(B.auth).expect(404);
    await request(app).post(`/api/deposits/instructions/${instr.id}/cancel`).set(B.auth).expect(404);
    await request(app).post('/api/deposits/instructions').set(B.auth).send({ walletId: A.wallet.id, asset: 'USDC_SOL', amount: '1' }).expect(404); // B cannot instruct on A's wallet
    await request(app).post('/api/deposits/instructions').set(noScope.auth).send({ walletId: noScope.wallet.id, asset: 'USDC_SOL', amount: '1' }).expect(403);
    await request(app).get('/api/settlements/x').expect(401);
    await request(app).post('/api/webhooks/endpoints').set(A.auth).send({ url: hookUrl }).expect(201);
    expect((await request(app).get('/api/webhooks/endpoints').set(B.auth).expect(200)).body).toEqual([]);
    await request(app).post('/api/webhooks/endpoints').set(A.auth).send({ url: 'ftp://x' }).expect(400);
    await request(app).post('/api/webhooks/endpoints').set(A.auth).send({ url: hookUrl, events: ['nope'] }).expect(400);
  });

  it('expiry sweep: a stale instruction becomes EXPIRED (status FAILED) and emits deposit.expired; failed deliveries follow the 1m/5m/30m/2h/12h schedule', async () => {
    const { expireDepositInstructions, publicStatus } = await import('../../packages/settlement/deposits/deposit-instruction.service');
    const { drain, INSTITUTION_RETRY_SCHEDULE_S, institutionRetryMs } = await import('../../packages/core/events/outbox.service');
    const A = await institution('expire');
    await request(app).post('/api/webhooks/endpoints').set(A.auth).send({ url: hookUrl, events: ['deposit.expired'] }).expect(201);
    const instr = (await request(app).post('/api/deposits/instructions').set(A.auth).send({ walletId: A.wallet.id, asset: 'USDC_SOL', amount: '1' }).expect(201)).body;
    await prisma.depositInstruction.update({ where: { id: instr.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(publicStatus(await prisma.depositInstruction.findUnique({ where: { id: instr.id } }))).toBe('FAILED');
    expect(await expireDepositInstructions()).toBeGreaterThanOrEqual(1);
    const row = await prisma.depositInstruction.findUnique({ where: { id: instr.id } });
    expect(row.status).toBe('EXPIRED');
    expect((await request(app).get(`/api/settlements/${instr.id}`).set(A.auth)).body.status).toBe('FAILED');
    // receiver down → retry scheduled per the documented table
    hookStatus = 503; try { await drain(); } finally { hookStatus = 200; }
    const ob = await prisma.outboxEvent.findFirst({ where: { entityType: 'DepositInstruction', entityId: instr.id, eventType: 'deposit.expired' } });
    expect(ob.status).toBe('PENDING'); expect(ob.attempts).toBe(1);
    expect(ob.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(50_000);
    expect(INSTITUTION_RETRY_SCHEDULE_S).toEqual([60, 300, 1800, 7200, 43200]);
    expect(institutionRetryMs(5)).toBe(43200_000); expect(institutionRetryMs(9)).toBe(43200_000);
  });

  it('secrets round-trip through encryption and production refuses to start without a key', async () => {
    const { encryptSecret, decryptSecret } = await import('../../packages/shared/secrets');
    const c = encryptSecret('whsec_x'); expect(c).toMatch(/^enc:v1:/); expect(decryptSecret(c)).toBe('whsec_x');
    const { loadConfig } = await import('../../packages/shared/config');
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x', API_BASE_URL: 'https://api.axlink.test/api', OPS_API_KEY: 'k'.repeat(32), FIREBLOCKS_WORKSPACE_ID: 'w', FIREBLOCKS_WEBHOOK_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----x', B2BINPAY_CALLBACK_SECRET: 's'.repeat(20) } as NodeJS.ProcessEnv;
    expect(() => loadConfig(base)).toThrow(/WEBHOOK_ENCRYPTION_KEY is required in production/);
    expect(() => loadConfig({ ...base, WEBHOOK_ENCRYPTION_KEY: 'a'.repeat(64) })).not.toThrow();
  });
});
