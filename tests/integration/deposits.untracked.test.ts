/**
 * Deposits from OUTSIDE the custody workspace (another custodian, another Fireblocks workspace, a
 * faucet) arrive without our `dep_…` tracking id — the sender's custodian sets `externalTxId`, not us.
 * They must still settle the institution's announced instruction, exactly once, and anything that
 * cannot be attributed must credit nothing and reach operations. Also: operator activation of an
 * institution through the API (no direct database edits during onboarding). Requires DATABASE_URL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
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
const SCOPES = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'ledger:read'];

db('untracked custody deposits and operator activation', () => {
  let app: import('express').Express; let prisma: any;
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service')); });

  async function onboard(tag: string) {
    const slug = `untr-${tag}-${randomUUID().slice(0, 8)}`;
    const inst = (await request(app).post('/api/institutions').set(ops).send({ slug, legalName: `Untracked ${tag}`, country: 'KE', kind: 'BANK' }).expect(201)).body;
    await request(app).post(`/api/institutions/${inst.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes: SCOPES }).expect(409); // PENDING
    await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'ACTIVE', reason: 'KYB approved' }).expect(200);
    const key = (await request(app).post(`/api/institutions/${inst.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes: SCOPES }).expect(201)).body;
    const auth = { Authorization: `Bearer ${key.apiKey}` };
    const wallet = (await request(app).post('/api/v1/wallets').set(auth).send({ label: 'Treasury' }).expect(201)).body;
    return { id: inst.id as string, auth, wallet };
  }
  const announce = async (t: Awaited<ReturnType<typeof onboard>>, amount: string) =>
    (await request(app).post('/api/v1/deposits').set(t.auth).send({ walletId: t.wallet.id, asset: 'USDC_SOL', amount }).expect(201)).body;

  /** A completed incoming transfer from an EXTERNAL wallet, with no externalTxId (as Fireblocks reports it). */
  async function receipt(vaultId: string, amount: number, fbId = `fb-${randomUUID()}`, opts: { status?: string; source?: { type: string; id?: string } } = {}) {
    const raw = JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: process.env.FIREBLOCKS_WORKSPACE_ID, data: {
      id: fbId, status: opts.status ?? 'COMPLETED', assetId: 'USDC_SOL', operation: 'TRANSFER', netAmount: amount, amount, txHash: `sig${randomUUID().replace(/-/g, '')}`,
      destination: { type: 'VAULT_ACCOUNT', id: vaultId }, source: opts.source ?? { type: 'UNKNOWN' } } });
    const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
    await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw).expect(200);
    return fbId;
  }
  const available = async (t: Awaited<ReturnType<typeof onboard>>) =>
    (await request(app).get('/api/v1/balances').set(t.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL')?.available ?? '0';
  const exceptionsFor = async (instId: string) =>
    (await request(app).get(`/api/settlement/exceptions?kind=UNATTRIBUTED_DEPOSIT&institutionId=${instId}`).set(ops).expect(200)).body.exceptions;

  it('operations activates through the API; illegal moves are refused', async () => {
    const inst = (await request(app).post('/api/institutions').set(ops).send({ slug: `untr-st-${randomUUID().slice(0, 8)}`, legalName: 'Status', country: 'KE', kind: 'BANK' }).expect(201)).body;
    await request(app).post(`/api/institutions/${inst.id}/status`).send({ status: 'ACTIVE', reason: 'x'.repeat(5) }).expect(401); // operators only
    await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'SUSPENDED', reason: 'too early' }).expect(409); // PENDING → SUSPENDED is not a move
    await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'ACTIVE' }).expect(400); // a reason is required
    expect((await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'ACTIVE', reason: 'KYB approved' }).expect(200)).body.status).toBe('ACTIVE');
    await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'CLOSED', reason: 'offboarded' }).expect(200);
    await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'ACTIVE', reason: 'reopen' }).expect(409); // CLOSED is terminal
  });

  it('an untracked receipt settles the one matching instruction, once', async () => {
    const A = await onboard('one');
    const dep = await announce(A, '25');
    const fbId = await receipt(A.wallet.custody.vaultId, 25);
    expect(await available(A)).toBe('25');
    const row = await prisma.depositInstruction.findUnique({ where: { trackingId: dep.trackingId } });
    expect(row.status).not.toBe('PENDING'); expect(row.providerTxId).toBe(fbId);
    await receipt(A.wallet.custody.vaultId, 25, fbId); // the same custody event again
    expect(await available(A)).toBe('25');
    expect(await exceptionsFor(A.id)).toEqual([]);
  });

  it('a receipt with no matching amount credits nothing and raises a CRITICAL exception', async () => {
    const A = await onboard('miss');
    await announce(A, '10');
    await receipt(A.wallet.custody.vaultId, 9.5);
    expect(await available(A)).toBe('0');
    const ex = await exceptionsFor(A.id);
    expect(ex).toHaveLength(1); expect(ex[0]).toMatchObject({ severity: 'CRITICAL', currency: 'USDC_SOL', actual: '9.5' });
    expect(ex[0].detail.reason).toMatch(/unattributed deposit/);
  });

  it('two instructions with the same amount are ambiguous: nothing is credited', async () => {
    const A = await onboard('amb');
    await announce(A, '7'); await announce(A, '7');
    await receipt(A.wallet.custody.vaultId, 7);
    expect(await available(A)).toBe('0');
    expect((await exceptionsFor(A.id))[0].detail.reason).toMatch(/ambiguous deposit/);
  });

  it('a receipt into another institution\'s vault never settles this institution\'s instruction', async () => {
    const A = await onboard('own'); const B = await onboard('other');
    await announce(A, '3');
    await receipt(B.wallet.custody.vaultId, 3); // B has no instruction
    expect(await available(A)).toBe('0'); expect(await available(B)).toBe('0');
    expect(await exceptionsFor(B.id)).toHaveLength(1);
  });

  // ── review findings at b688516 ──
  it('concurrent same-amount receipts: one settles, every other one alerts operations (none silently ignored)', async () => {
    const A = await onboard('conc');
    await announce(A, '25');
    await Promise.all([1, 2, 3].map(() => receipt(A.wallet.custody.vaultId, 25)));
    expect(await available(A)).toBe('25');
    expect(await exceptionsFor(A.id)).toHaveLength(2);
  });

  it('the same custody transaction under a different event id never settles a second instruction', async () => {
    const A = await onboard('redeliver');
    await announce(A, '5');
    const fbId = await receipt(A.wallet.custody.vaultId, 5);
    expect(await available(A)).toBe('5');
    await announce(A, '5'); // a second, legitimate instruction of the same amount
    await receipt(A.wallet.custody.vaultId, 5, fbId, { status: 'completed' }); // same tx; label still 'completed', eventId differs (…:completed vs …:COMPLETED)
    expect(await available(A)).toBe('5');
  });

  it('an internal custody movement neither settles nor touches an unrelated instruction, and raises no false alarm', async () => {
    const A = await onboard('internal'); const B = await onboard('internal-src');
    const dep = await announce(A, '4');
    await receipt(A.wallet.custody.vaultId, 4, undefined, { source: { type: 'VAULT_ACCOUNT', id: B.wallet.custody.vaultId } });
    expect(await available(A)).toBe('0');
    const row = await prisma.depositInstruction.findUnique({ where: { trackingId: dep.trackingId } });
    expect(row.status).toBe('PENDING'); expect(row.lastReceiptError).toBeNull();
    expect(await exceptionsFor(A.id)).toEqual([]);
  });

  it('a receipt into a wallet of another network (a recycled vault id after a sandbox→live switch) is never credited', async () => {
    const A = await onboard('othernet');
    await announce(A, '6');
    await prisma.wallet.update({ where: { id: A.wallet.id }, data: { network: 'solana-devnet' } }); // this deployment is mainnet
    await receipt(A.wallet.custody.vaultId, 6);
    expect(await available(A)).toBe('0');
    expect((await exceptionsFor(A.id))[0].detail.reason).toMatch(/wallet is on solana-devnet/);
  });

  it('concurrent status changes cannot reopen a CLOSED institution', async () => {
    const inst = (await request(app).post('/api/institutions').set(ops).send({ slug: `untr-race-${randomUUID().slice(0, 8)}`, legalName: 'Race', country: 'KE', kind: 'BANK' }).expect(201)).body;
    await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'ACTIVE', reason: 'KYB approved' }).expect(200);
    await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'SUSPENDED', reason: 'hold' }).expect(200);
    await Promise.all([
      request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'CLOSED', reason: 'offboard' }),
      request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'ACTIVE', reason: 'reopen' }),
    ]);
    const final = await prisma.institution.findUnique({ where: { id: inst.id } });
    if (final.status === 'CLOSED') await request(app).post(`/api/institutions/${inst.id}/status`).set(ops).send({ status: 'ACTIVE', reason: 'again' }).expect(409);
    expect(['CLOSED', 'ACTIVE']).toContain(final.status);
  });
});

