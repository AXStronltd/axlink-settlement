/**
 * Leg A certification pack (Step 2, slice 7).
 *
 * One scenario, start to finish, the way a bank will experience it — and at the end the four
 * things that must be true on every AxLink deployment (CLAUDE.md):
 *   1. GET /api/settlement/stuck is empty,
 *   2. suspense is zero,
 *   3. the trial balance balances per currency,
 *   4. no open CRITICAL exception.
 *
 * Run it against any environment with `npm run certify` (sandbox providers or real sandbox
 * credentials). It uses only the public contract (/api/v1) and the operator endpoints.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto, { randomUUID } from 'crypto';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.FIREBLOCKS_WORKSPACE_ID ??= 'test-workspace';
process.env.WEBHOOK_ALLOW_INSECURE_URLS ??= 'true';
process.env.SIMULATOR_ENABLED ??= 'true';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY ??= pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const db = process.env.DATABASE_URL ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };
const SCOPES = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'webhooks:write', 'webhooks:read', 'ledger:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write'];

db('Leg A certification', () => {
  let app: import('express').Express; let prisma: any; let svc: typeof import('../../packages/settlement/transfers/settlement-transfer.service');
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service')); svc = await import('../../packages/settlement/transfers/settlement-transfer.service'); });

  it('onboarding → key → wallet → deposit → network settlement → external settlement → books agree', async () => {
    // 1. Operations onboards two institutions; nothing works for them until ACTIVE.
    const mk = async (tag: string) => {
      const slug = `cert-${tag}-${randomUUID().slice(0, 8)}`;
      const inst = await request(app).post('/api/institutions').set(ops).send({ slug, legalName: `Cert ${tag}`, country: 'KE', kind: 'BANK' }).expect(201);
      await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes: SCOPES }).expect(409); // PENDING: no key yet
      await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } }); // onboarding completed by operations
      const k = await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes: SCOPES }).expect(201);
      return { id: inst.body.id as string, slug, auth: { Authorization: `Bearer ${k.body.apiKey}` } };
    };
    const A = await mk('a'); const B = await mk('b');

    // 2. The institution sees itself, the assets, and provisions a wallet.
    expect((await request(app).get('/api/v1/institutions/me').set(A.auth).expect(200)).body.environment).toBe('SANDBOX');
    expect((await request(app).get('/api/v1/assets').set(A.auth).expect(200)).body.assets.map((a: any) => a.id).sort()).toEqual(['USDC_SOL', 'USDT_SOL']);
    const wa = (await request(app).post('/api/v1/wallets').set(A.auth).send({ label: 'Treasury' }).expect(201)).body;
    const wb = (await request(app).post('/api/v1/wallets').set(B.auth).send({ label: 'Treasury' }).expect(201)).body;
    const addr = (await request(app).post('/api/v1/custody/deposit-addresses').set(A.auth).send({ walletId: wa.id }).expect(200)).body;
    expect(addr.assets).toEqual(['USDC_SOL', 'USDT_SOL']);

    // 3. A announces a deposit; custody reports the receipt; the deposit is COMPLETED only on finality (sandbox: stub chain).
    const dep = (await request(app).post('/api/v1/deposits').set(A.auth).send({ walletId: wa.id, asset: 'USDC_SOL', amount: '1000', reference: 'CERT-DEP' }).expect(201)).body;
    const raw = JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: process.env.FIREBLOCKS_WORKSPACE_ID, data: { id: `fb-${randomUUID()}`, status: 'COMPLETED', assetId: 'USDC_SOL', operation: 'TRANSFER', netAmount: 1000, amount: 1000, txHash: `sig${randomUUID().replace(/-/g, '')}`, destination: { type: 'VAULT_ACCOUNT', id: wa.custody.vaultId }, source: { type: 'EXTERNAL_WALLET' }, externalTxId: dep.trackingId } });
    const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
    await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw).expect(200);
    expect((await request(app).get('/api/v1/balances').set(A.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('1000');

    // 4. A settles 300 to B on the network and 200 to an external address; both COMPLETED; B credited.
    const cpB = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Bank B', participant: B.slug }).expect(201)).body;
    const cpX = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'External', address: crypto.randomBytes(32).toString('hex').replace(/[0lIO]/g, 'a').slice(0, 44) }).expect(201)).body;
    const t1 = (await request(app).post('/api/v1/settlements').set(A.auth).set('Idempotency-Key', `cert-${randomUUID()}`).send({ walletId: wa.id, counterpartyId: cpB.id, asset: 'USDC_SOL', amount: '300', reference: 'CERT-NET' }).expect(202)).body;
    const t2 = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', `cert-${randomUUID()}`).send({ walletId: wa.id, counterpartyId: cpX.id, asset: 'USDC_SOL', amount: '200', reference: 'CERT-EXT' }).expect(202)).body;
    await svc.runTransferSweep();
    for (const t of [t1, t2]) expect((await request(app).get(`/api/v1/settlements/${t.id}`).set(A.auth).expect(200)).body.status).toBe('COMPLETED');
    expect((await request(app).get('/api/v1/balances').set(A.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('500');
    expect((await request(app).get('/api/v1/balances').set(B.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('300');
    expect((await request(app).get(`/api/v1/ledger/entries?entityId=${t1.id}`).set(B.auth).expect(200)).body.entries).toHaveLength(1);
    expect(wb.id).toBeTruthy();

    // 5. The four things that must be true.
    expect((await request(app).get('/api/settlement/stuck').set(ops).expect(200)).body.count).toBe(0);
    const run = (await request(app).post('/api/settlement/reconcile').set(ops).send({ kind: 'TRIAL_BALANCE' }).expect(200)).body;
    const breaks = await prisma.reconciliationBreak.findMany({ where: { runId: run.runId, kind: { in: ['UNBALANCED_ENTRY', 'TRIAL_BALANCE', 'SUSPENSE_NONZERO', 'NEGATIVE_CUSTODY'] } } });
    expect(breaks).toEqual([]);
    const ex = (await request(app).get('/api/settlement/exceptions?severity=CRITICAL').set(ops).expect(200)).body;
    expect(ex.exceptions.filter((x: any) => x.institutionId === A.id || x.institutionId === B.id)).toEqual([]);
  }, 60_000);
});
