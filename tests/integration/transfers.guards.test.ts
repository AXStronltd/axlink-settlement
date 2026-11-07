/**
 * Review findings on PR #6 (b688516), outbound side:
 *  - a SUSPENDED institution moves nothing: queued APPROVED transfers are held, AWAITING ones cannot be approved;
 *  - a transfer whose wallet is not on this deployment's network/environment (a sandbox row after a switch
 *    to live: vault ids are per workspace) is refused before it can reach custody, and the journal is restored.
 * Requires DATABASE_URL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto, { randomUUID } from 'crypto';
process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.FIREBLOCKS_WORKSPACE_ID = 'test-workspace';
process.env.WEBHOOK_ALLOW_INSECURE_URLS = 'true';
process.env.SIMULATOR_ENABLED = 'true';
process.env.TRANSFER_AUTO_APPROVE_LIMIT_SANDBOX = '50';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const db = process.env.DATABASE_URL ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };
const ADDR = () => crypto.randomBytes(32).toString('hex').replace(/[0lIO]/g, 'a').slice(0, 44);
const ALL = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'ledger:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write'];

db('outbound guards', () => {
  let app: import('express').Express; let prisma: any; let svc: typeof import('../../packages/settlement/transfers/settlement-transfer.service');
  beforeAll(async () => {
    ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service'));
    svc = await import('../../packages/settlement/transfers/settlement-transfer.service');
  });

  async function funded(tag: string, amount: number) {
    const inst = (await request(app).post('/api/institutions').set(ops).send({ slug: `grd-${tag}-${randomUUID().slice(0, 8)}`, legalName: `Guard ${tag}`, country: 'KE', kind: 'BANK' }).expect(201)).body;
    await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'ACTIVE', reason: 'test' }).expect(200);
    const key = (await request(app).post(`/api/institutions/${inst.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes: ALL }).expect(201)).body;
    const auth = { Authorization: `Bearer ${key.apiKey}` };
    const wallet = (await request(app).post('/api/v1/wallets').set(auth).send({ label: 'Main' }).expect(201)).body;
    const d = (await request(app).post('/api/v1/deposits').set(auth).send({ walletId: wallet.id, asset: 'USDC_SOL', amount: String(amount) }).expect(201)).body;
    const raw = JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data: { id: `fb-${randomUUID()}`, status: 'COMPLETED', assetId: 'USDC_SOL', operation: 'TRANSFER', netAmount: amount, amount, txHash: `sig${randomUUID().replace(/-/g, '')}`, destination: { type: 'VAULT_ACCOUNT', id: wallet.custody.vaultId }, source: { type: 'EXTERNAL_WALLET' }, externalTxId: d.trackingId } });
    await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64') }).send(raw).expect(200);
    const cp = (await request(app).post('/api/v1/counterparties').set(auth).send({ label: 'Partner', address: ADDR() }).expect(201)).body;
    return { id: inst.id as string, auth, wallet, cp };
  }
  const send = async (A: Awaited<ReturnType<typeof funded>>, amount: string) =>
    (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', `g-${randomUUID()}`).send({ walletId: A.wallet.id, counterpartyId: A.cp.id, asset: 'USDC_SOL', amount }).expect(202)).body;
  const row = (id: string) => prisma.settlementTransfer.findUnique({ where: { id } });
  const available = async (A: Awaited<ReturnType<typeof funded>>) =>
    (await request(app).get('/api/v1/balances').set(A.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available;

  it('a suspended institution\'s approved transfer is held, and its awaiting transfer cannot be approved', async () => {
    const A = await funded('susp', 200);
    const queued = await send(A, '10');   // under the sandbox limit: auto-approved
    const waiting = await send(A, '80');  // over it: awaits an operator
    expect((await row(queued.id)).status).toBe('APPROVED');
    expect((await row(waiting.id)).status).toBe('AWAITING_APPROVAL');
    await request(app).post(`/api/institutions/${A.id}/status`).set(ops).send({ status: 'SUSPENDED', reason: 'compromised key' }).expect(200);

    await svc.submitApprovedTransfers();
    expect((await row(queued.id)).status).toBe('APPROVED'); // held, not sent
    await expect(svc.approveTransfer(waiting.id, 'ops')).rejects.toMatchObject({ code: 'INSTITUTION_NOT_ACTIVE' });
    expect((await row(waiting.id)).status).toBe('AWAITING_APPROVAL');

    await request(app).post(`/api/institutions/${A.id}/status`).set(ops).send({ status: 'ACTIVE', reason: 'key rotated' }).expect(200);
    await svc.submitApprovedTransfers();
    expect((await row(queued.id)).status).not.toBe('APPROVED'); // released once reinstated
  });

  it('a transfer whose wallet is on another network is refused before custody and the journal is restored', async () => {
    const A = await funded('net', 100);
    const t = await send(A, '30');
    expect(await available(A)).toBe('70');
    await prisma.wallet.update({ where: { id: A.wallet.id }, data: { network: 'solana-devnet' } }); // this deployment settles on mainnet
    await svc.submitApprovedTransfers();
    const r = await row(t.id);
    expect(r.status).toBe('FAILED'); expect(r.providerTxId).toBeNull();
    expect(r.failureReason).toMatch(/wallet is on solana-devnet/);
    await prisma.wallet.update({ where: { id: A.wallet.id }, data: { network: 'solana-mainnet' } });
    expect(await available(A)).toBe('100');
  });

  it('a wallet on another network cannot have a transfer approved', async () => {
    const A = await funded('netappr', 200);
    const waiting = await send(A, '80');
    await prisma.wallet.update({ where: { id: A.wallet.id }, data: { network: 'solana-devnet' } });
    await expect(svc.approveTransfer(waiting.id, 'ops')).rejects.toMatchObject({ code: 'WRONG_DEPLOYMENT' });
  });
});
