/**
 * Step 2 · slice 1 — Wallets. Institution → custody vault → per-asset balances, environment-bound.
 * Requires DATABASE_URL (isolated PostgreSQL). Custody is the sandbox stub (no Fireblocks credentials).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.FIREBLOCKS_WORKSPACE_ID ??= 'test-workspace';

const db = process.env.DATABASE_URL ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };

db('wallets', () => {
  let app: import('express').Express; let prisma: any;
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service')); });

  async function institution(tag: string, scopes = ['wallets:read']) {
    const id = randomUUID().slice(0, 8);
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug: `w-${tag}-${id}`, legalName: `Wallet ${tag}`, country: 'KE', kind: 'BANK' }).expect(201);
    await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } });
    const key = await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes }).expect(201);
    return { id: inst.body.id as string, key: key.body.apiKey as string, auth: { Authorization: `Bearer ${key.body.apiKey}` } };
  }

  it('operator creates a sandbox wallet: one vault, one deposit address, a zero balance per supported asset', async () => {
    const A = await institution('create');
    const w = await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'Treasury' }).expect(201);
    expect(w.body).toMatchObject({ label: 'Treasury', status: 'ACTIVE', network: 'solana-mainnet', environment: 'SANDBOX', custody: { provider: 'fireblocks' } });
    expect(w.body.custody.vaultId).toMatch(/^vault_sbx_/);
    expect(typeof w.body.depositAddress).toBe('string');
    expect(w.body.balances.map((b: any) => [b.asset, b.available]).sort()).toEqual([['USDC_SOL', '0'], ['USDT_SOL', '0']]);
  });

  it('a production wallet is refused while that environment is disabled, and while custody is unconfigured in production', async () => {
    const A = await institution('prod');
    await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'PRODUCTION', label: 'x' }).expect(409);
    await prisma.apiEnvironment.update({ where: { institutionId_kind: { institutionId: A.id, kind: 'PRODUCTION' } }, data: { status: 'ACTIVE' } });
    const saved = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try { await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'PRODUCTION', label: 'x' }).expect(503); }
    finally { process.env.NODE_ENV = saved; }
  });

  it('an unsupported network is refused', async () => {
    const A = await institution('net');
    await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'x', network: 'ethereum-mainnet' }).expect(400);
  });

  it('institution credentials see only their own wallets in their own environment; others are 404', async () => {
    const A = await institution('a'); const B = await institution('b');
    const wa = await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'A1' }).expect(201);
    const wb = await request(app).post(`/api/institutions/${B.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'B1' }).expect(201);
    // A production wallet of A must not be visible to A's SANDBOX credential either.
    await prisma.apiEnvironment.update({ where: { institutionId_kind: { institutionId: A.id, kind: 'PRODUCTION' } }, data: { status: 'ACTIVE' } });
    const wap = await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'PRODUCTION', label: 'A-prod' }).expect(201);

    const list = await request(app).get('/api/wallets').set(A.auth).expect(200);
    expect(list.body.map((w: any) => w.id)).toEqual([wa.body.id]);
    await request(app).get(`/api/wallets/${wa.body.id}`).set(A.auth).expect(200);
    await request(app).get(`/api/wallets/${wb.body.id}`).set(A.auth).expect(404);
    await request(app).get(`/api/wallets/${wap.body.id}`).set(A.auth).expect(404);
    await request(app).get(`/api/wallets/${wb.body.id}/balances`).set(A.auth).expect(404);
    await request(app).get('/api/wallets').expect(401);
    // operator sees both environments
    const all = await request(app).get(`/api/institutions/${A.id}/wallets`).set(ops).expect(200);
    expect(all.body.map((w: any) => w.environment).sort()).toEqual(['PRODUCTION', 'SANDBOX']);
  });

  it('a credential without wallets:read is refused', async () => {
    const A = await institution('scope', []);
    await request(app).get('/api/wallets').set(A.auth).expect(403);
  });

  it('a custody receipt into the wallet vault moves the wallet balance with the journal, atomically, and records walletId on the event', async () => {
    const { processOnce } = await import('../../packages/webhooks/provider-event.service');
    const { applyCustodyDeposit } = await import('../../packages/webhooks/custody-deposit');
    const A = await institution('dep');
    const w = await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'Ops' }).expect(201);
    const id = randomUUID();
    // Legacy instruction rows still name a User; link that user to the wallet's vault and institution.
    const user = await prisma.user.create({ data: { email: `${id}@example.test`, name: 'Dep', vaultId: w.body.custody.vaultId, institutionId: A.id } });
    const dep = await prisma.bankDeposit.create({ data: { userId: user.id, trackingId: `dep_${id}`, currency: 'USDC', amount: '25.5', usdAmount: '25.5', usdtAmount: '25.5', status: 'PENDING_FIREBLOCKS', bankName: 'sandbox', settlementAssetId: 'USDC_SOL' } });
    const ev = { provider: 'fireblocks' as const, operation: 'TRANSFER', destinationType: 'VAULT_ACCOUNT', providerAssetId: 'USDC_SOL', destinationVaultId: w.body.custody.vaultId, externalTxId: dep.trackingId, providerTxId: id, amount: '25.5' };
    const r = await processOnce({ provider: 'fireblocks', eventId: id, rawBody: JSON.stringify(ev) }, tx => applyCustodyDeposit(tx, ev));
    expect(r.duplicate).toBe(false); expect(r.outcome?.status).toBe('PROCESSED'); expect(r.outcome?.walletId).toBe(w.body.id);

    const bal = await request(app).get(`/api/wallets/${w.body.id}/balances`).set(A.auth).expect(200);
    expect(bal.body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('25.5');
    expect(bal.body.balances.find((b: any) => b.asset === 'USDT_SOL').available).toBe('0');
    const ev2 = await prisma.providerEvent.findUnique({ where: { provider_eventId: { provider: 'fireblocks', eventId: id } } });
    expect(ev2.walletId).toBe(w.body.id); expect(ev2.institutionId).toBe(A.id);
    // replay: nothing moves
    const r2 = await processOnce({ provider: 'fireblocks', eventId: id, rawBody: JSON.stringify(ev) }, tx => applyCustodyDeposit(tx, ev));
    expect(r2.duplicate).toBe(true);
    expect((await request(app).get(`/api/wallets/${w.body.id}/balances`).set(A.auth)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('25.5');
  });

  it('a receipt is rejected when the wallet is suspended or the vault belongs to another institution than the instruction', async () => {
    const { processOnce } = await import('../../packages/webhooks/provider-event.service');
    const { applyCustodyDeposit } = await import('../../packages/webhooks/custody-deposit');
    const A = await institution('rej'); const B = await institution('rej2');
    const w = await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'S' }).expect(201);
    const id = randomUUID();
    // user claims institution B but the vault is A's wallet → REJECTED, no credit
    const user = await prisma.user.create({ data: { email: `${id}@example.test`, name: 'X', vaultId: w.body.custody.vaultId, institutionId: B.id } });
    const dep = await prisma.bankDeposit.create({ data: { userId: user.id, trackingId: `dep_${id}`, currency: 'USDT', amount: '1', usdAmount: '1', usdtAmount: '1', status: 'PENDING_FIREBLOCKS', bankName: 'sandbox', settlementAssetId: 'USDT_SOL' } });
    const ev = { provider: 'fireblocks' as const, operation: 'TRANSFER', destinationType: 'VAULT_ACCOUNT', providerAssetId: 'USDT_SOL', destinationVaultId: w.body.custody.vaultId, externalTxId: dep.trackingId, providerTxId: id, amount: '1' };
    const r = await processOnce({ provider: 'fireblocks', eventId: id, rawBody: JSON.stringify(ev) }, tx => applyCustodyDeposit(tx, ev));
    expect(r.outcome?.status).toBe('REJECTED');
    expect((await prisma.walletBalance.findUnique({ where: { walletId_assetId: { walletId: w.body.id, assetId: 'USDT_SOL' } } })).available.toString()).toBe('0');
    expect((await prisma.bankDeposit.findUnique({ where: { id: dep.id } })).status).toBe('PENDING_FIREBLOCKS');
    // fix the owner, suspend the wallet → still rejected
    await prisma.user.update({ where: { id: user.id }, data: { institutionId: A.id } });
    await prisma.wallet.update({ where: { id: w.body.id }, data: { status: 'SUSPENDED' } });
    const r2 = await processOnce({ provider: 'fireblocks', eventId: `${id}-2`, rawBody: 'x' }, tx => applyCustodyDeposit(tx, { ...ev, providerTxId: `${id}-2` }));
    expect(r2.outcome?.status).toBe('REJECTED');
  });

  it('backfill: a legacy user with a vault and an institution gets a sandbox wallet carrying its canonical balances', async () => {
    const A = await institution('bf');
    const id = randomUUID();
    const user = await prisma.user.create({ data: { email: `${id}@example.test`, name: 'Legacy', vaultId: `vault-legacy-${id}`, institutionId: A.id } });
    await prisma.account.create({ data: { userId: user.id, currency: 'USDT_SOL', balance: new Prisma.Decimal('7.25'), balanceUsd: new Prisma.Decimal('7.25') } });
    const { execSync } = await import('child_process');
    const out = execSync('npx ts-node scripts/backfill-wallets.ts', { env: process.env, encoding: 'utf8' });
    expect(out).toMatch(/wallet\(s\) created/);
    const w = await prisma.wallet.findUnique({ where: { legacyUserId: user.id }, include: { balances: true } });
    expect(w).not.toBeNull(); expect(w.custodyVaultId).toBe(user.vaultId); expect(w.institutionId).toBe(A.id);
    expect(w.balances.find((b: any) => b.assetId === 'USDT_SOL').available.toString()).toBe('7.25');
    // idempotent
    execSync('npx ts-node scripts/backfill-wallets.ts', { env: process.env, encoding: 'utf8' });
    expect(await prisma.wallet.count({ where: { legacyUserId: user.id } })).toBe(1);
  });
});
