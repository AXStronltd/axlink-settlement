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
    // A production wallet of A must not be visible to A's SANDBOX credential either. (Inserted directly:
    // the API refuses to create a PRODUCTION wallet on sandbox custody — tested above.)
    const prodEnv = await prisma.apiEnvironment.update({ where: { institutionId_kind: { institutionId: A.id, kind: 'PRODUCTION' } }, data: { status: 'ACTIVE' } });
    const wap = { body: await prisma.wallet.create({ data: { institutionId: A.id, environmentId: prodEnv.id, label: 'A-prod', custodyVaultId: `vault-prod-${randomUUID()}`, network: 'solana-mainnet' } }) };

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
    // fix the owner, suspend the wallet → the receipt is DEFERRED: the transaction rolls back and no
    // event row is written, so the provider's retry settles it once the wallet is active again.
    await prisma.user.update({ where: { id: user.id }, data: { institutionId: A.id } });
    await prisma.wallet.update({ where: { id: w.body.id }, data: { status: 'SUSPENDED' } });
    await expect(processOnce({ provider: 'fireblocks', eventId: `${id}-2`, rawBody: 'x' }, tx => applyCustodyDeposit(tx, { ...ev, providerTxId: `${id}-2` }))).rejects.toMatchObject({ code: 'WALLET_SUSPENDED' });
    expect(await prisma.providerEvent.findUnique({ where: { provider_eventId: { provider: 'fireblocks', eventId: `${id}-2` } } })).toBeNull();
    expect((await prisma.bankDeposit.findUnique({ where: { id: dep.id } })).status).toBe('PENDING_FIREBLOCKS');
    // re-activate → the same event now settles
    await prisma.wallet.update({ where: { id: w.body.id }, data: { status: 'ACTIVE' } });
    const r3 = await processOnce({ provider: 'fireblocks', eventId: `${id}-2`, rawBody: 'x' }, tx => applyCustodyDeposit(tx, { ...ev, providerTxId: `${id}-2` }));
    expect(r3.outcome?.status).toBe('PROCESSED');
    expect((await request(app).get(`/api/wallets/${w.body.id}/balances`).set(A.auth)).body.balances.find((b: any) => b.asset === 'USDT_SOL').available).toBe('1');
    // a CLOSED wallet is a hard rejection
    await prisma.wallet.update({ where: { id: w.body.id }, data: { status: 'CLOSED' } });
    const dep2 = await prisma.bankDeposit.create({ data: { userId: user.id, trackingId: `dep_${id}-c`, currency: 'USDT', amount: '1', usdAmount: '1', usdtAmount: '1', status: 'PENDING_FIREBLOCKS', bankName: 'sandbox', settlementAssetId: 'USDT_SOL' } });
    const r4 = await processOnce({ provider: 'fireblocks', eventId: `${id}-3`, rawBody: 'x' }, tx => applyCustodyDeposit(tx, { ...ev, externalTxId: dep2.trackingId, providerTxId: `${id}-3` }));
    expect(r4.outcome?.status).toBe('REJECTED');
  });

  it('backfill: a legacy user with a vault and an institution gets a sandbox wallet carrying its canonical balances', async () => {
    const A = await institution('bf');
    const id = randomUUID();
    const user = await prisma.user.create({ data: { email: `${id}@example.test`, name: 'Legacy', vaultId: `vault-legacy-${id}`, institutionId: A.id } });
    // Legacy state = journal custody lines (source of truth) + the Account projection.
    const { post } = await import('../../packages/core/ledger/journal.service');
    const { AccountCode } = await import('../../packages/core/ledger/accounts');
    await prisma.$transaction(async (tx: any) => post(tx, { eventType: 'DEPOSIT', entityType: 'Backfill', entityId: id, postingKey: `bf:${id}`, narrative: 'legacy', lines: [
      { account: AccountCode.custody(user.vaultId, 'USDT_SOL'), currency: 'USDT_SOL', amount: '7.25', usdAmount: '7.25' },
      { account: AccountCode.user(user.id, 'USDT_SOL'), userId: user.id, currency: 'USDT_SOL', amount: '-7.25', usdAmount: '-7.25' },
    ] }));
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

  it('a receipt from production custody never lands in a sandbox wallet (environment binding)', async () => {
    const { processOnce } = await import('../../packages/webhooks/provider-event.service');
    const { applyCustodyDeposit } = await import('../../packages/webhooks/custody-deposit');
    const { setWalletCustody } = await import('../../packages/core/wallets/wallet.service');
    const A = await institution('envbind');
    const w = await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'S' }).expect(201);
    const id = randomUUID();
    const user = await prisma.user.create({ data: { email: `${id}@example.test`, name: 'X', vaultId: w.body.custody.vaultId, institutionId: A.id } });
    const dep = await prisma.bankDeposit.create({ data: { userId: user.id, trackingId: `dep_${id}`, currency: 'USDT', amount: '1', usdAmount: '1', usdtAmount: '1', status: 'PENDING_FIREBLOCKS', bankName: 'sandbox', settlementAssetId: 'USDT_SOL' } });
    const ev = { provider: 'fireblocks' as const, operation: 'TRANSFER', destinationType: 'VAULT_ACCOUNT', providerAssetId: 'USDT_SOL', destinationVaultId: w.body.custody.vaultId, externalTxId: dep.trackingId, providerTxId: id, amount: '1' };
    // Pretend this deployment holds real production custody credentials.
    setWalletCustody({ provider: 'fireblocks', configured: () => true, createVault: async () => ({ vaultId: 'x' }), createDepositAddress: async () => ({ address: 'x' }) });
    try {
      const r = await processOnce({ provider: 'fireblocks', eventId: id, rawBody: 'x' }, tx => applyCustodyDeposit(tx, ev));
      expect(r.outcome?.status).toBe('REJECTED'); expect(r.outcome?.reason).toMatch(/custody is PRODUCTION but wallet is SANDBOX/);
      // and sandbox wallets cannot be created on a production-bound deployment
      await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'S2' }).expect(409);
    } finally { setWalletCustody(null); }
    expect((await prisma.bankDeposit.findUnique({ where: { id: dep.id } })).status).toBe('PENDING_FIREBLOCKS');
  });

  it('the API serves the journal figure; reconciliation flags a projection that drifts from it', async () => {
    const { runReconciliation } = await import('../../packages/settlement/reconciliation/reconciliation.service');
    const A = await institution('drift');
    const w = await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'D' }).expect(201);
    // Corrupt the projection directly (simulates a debit path that forgot the wallet).
    await prisma.walletBalance.update({ where: { walletId_assetId: { walletId: w.body.id, assetId: 'USDC_SOL' } }, data: { available: new Prisma.Decimal('99') } });
    const b = (await request(app).get(`/api/wallets/${w.body.id}/balances`).set(A.auth).expect(200)).body.balances.find((x: any) => x.asset === 'USDC_SOL');
    expect(b.available).toBe('0'); expect(b.projected).toBe('99'); expect(b.drift).toBe(true);
    const run = await runReconciliation('TRIAL_BALANCE');
    expect(run.status).toBe('BREAKS');
    expect((run.summary as any).walletProjection.drifted).toBeGreaterThanOrEqual(1);
    const brk = await prisma.reconciliationBreak.findFirst({ where: { runId: run.runId, subject: `WALLET:${w.body.id}:USDC_SOL` } });
    expect(brk?.severity).toBe('CRITICAL');
  });

  it('a duplicate label in the same environment is refused with the existing wallet id (no second vault)', async () => {
    const A = await institution('dup');
    const w = await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'Same' }).expect(201);
    const r = await request(app).post(`/api/institutions/${A.id}/wallets`).set(ops).send({ environment: 'SANDBOX', label: 'Same' }).expect(409);
    expect(r.body.error.details.walletId).toBe(w.body.id);
    expect(await prisma.wallet.count({ where: { institutionId: A.id } })).toBe(1);
  });
});
