import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { prisma, debit, credit } from '../../packages/core/ledger/ledger.service';
import { applyCustodyDeposit } from '../../packages/webhooks/custody-deposit';
import { processOnce } from '../../packages/webhooks/provider-event.service';
import { ASSETS, getAsset, isAssetId } from '../../packages/core/assets/registry';
import { admitWebhook } from '../../packages/webhooks/webhook-policy';

process.env.FIREBLOCKS_WORKSPACE_ID = 'test-workspace';
process.env.OPS_API_KEY ??= 'final-security-test-operator-key';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.SETTLEMENT_WORKER_ENABLED = 'false';
process.env.OUTBOX_WORKER_ENABLED = 'false';

it('F2: even an explicit development bypass cannot admit an unsigned custody callback', () => {
  const saved = process.env.ALLOW_UNVERIFIED_WEBHOOKS;
  process.env.ALLOW_UNVERIFIED_WEBHOOKS = 'true';
  try { expect(admitWebhook({ provider: 'fireblocks', secretConfigured: false, signaturePresent: false, verify: () => false }).ok).toBe(false); }
  finally { if (saved === undefined) delete process.env.ALLOW_UNVERIFIED_WEBHOOKS; else process.env.ALLOW_UNVERIFIED_WEBHOOKS = saved; }
});
it('F6: registry lookup rejects prototype keys and includes supported status', () => {
  expect(() => getAsset('constructor')).toThrow();
  expect(isAssetId('toString')).toBe(false);
  expect(ASSETS.USDC_SOL).toHaveProperty('supported', true);
});

const db = process.env.DATABASE_URL ? describe : describe.skip;
db('final remediation against PostgreSQL', () => {
  let app: import('express').Express;
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); });
  async function fixture(symbol = 'USDT', status = 'PENDING_FIREBLOCKS', amount = '100.123456') {
    const id = randomUUID();
    const inst = await prisma.institution.create({ data: { slug: `f-${id}`, legalName: 'Final Test', country: 'KE', kind: 'BANK', status: 'ACTIVE', environments: { create: { kind: 'SANDBOX', status: 'ACTIVE' } } } });
    const user = await prisma.user.create({ data: { email: `${id}@example.test`, name: 'Test', vaultId: `vault-${id}`, institutionId: inst.id } });
    const deposit = await prisma.bankDeposit.create({ data: { userId: user.id, trackingId: `dep_${id}`, currency: symbol, amount, usdAmount: amount, usdtAmount: amount, status, bankName: 'sandbox', settlementAssetId: `${symbol}_SOL` } });
    const ev = { provider: 'fireblocks' as const, operation: 'TRANSFER', destinationType: 'VAULT_ACCOUNT', providerAssetId: `${symbol}_SOL`, destinationVaultId: user.vaultId, externalTxId: deposit.trackingId, providerTxId: id, amount };
    const apply = (change: object = {}, eventId: string = id) => processOnce({ provider: 'fireblocks', eventId, rawBody: JSON.stringify({ ...ev, ...change }) }, tx => applyCustodyDeposit(tx, { ...ev, ...change }));
    const balances = () => prisma.account.findMany({ where: { userId: user.id } });
    return { inst, user, deposit, ev, apply, balances };
  }
  for (const symbol of ['USDT', 'USDC']) {
    it(`F3/F5: ${symbol} credits a distinct canonical asset balance and two balanced journal lines`, async () => {
      const f = await fixture(symbol); await f.apply();
      const rows = await f.balances();
      expect(rows).toHaveLength(1); expect(rows[0].currency).toBe(`${symbol}_SOL`); expect(rows[0].balance.toString()).toBe('100.123456');
      const entries = await prisma.journalEntry.findMany({ where: { entityType: 'BankDeposit', entityId: f.deposit.id }, include: { lines: true } });
      expect(entries).toHaveLength(1); expect(entries[0].lines).toHaveLength(2);
      expect(entries[0].lines.every(l => l.currency === `${symbol}_SOL`)).toBe(true);
      expect(entries[0].lines.reduce((s, l) => s.add(l.amount), new Prisma.Decimal(0)).toString()).toBe('0');
    });
  }
  for (const [name, change] of Object.entries({
    underpayment: { amount: '0.000001' }, overpayment: { amount: '200' }, missingAmount: { amount: undefined },
    imprecise: { amount: '100.1234567' }, negative: { amount: '-100.123456' }, nan: { amount: 'NaN' },
    wrongToken: { providerAssetId: 'USDC_SOL' }, noTracking: { externalTxId: undefined },
    wrongNetwork: { network: 'ethereum-mainnet' }, wrongMint: { contract: 'wrong-mint' },
  })) {
    it(`F3: ${name} cannot credit or complete a deposit`, async () => {
      const f = await fixture(); const result = await f.apply(change);
      expect(result.outcome?.status).toBe('REJECTED');
      expect(await f.balances()).toHaveLength(0);
      expect((await prisma.bankDeposit.findUniqueOrThrow({ where: { id: f.deposit.id } })).status).toBe('PENDING_FIREBLOCKS');
    });
  }
  for (const status of ['FAILED', 'CANCELLED', 'REVERSED']) {
    it(`F3: ${status} deposit cannot be resurrected`, async () => {
      const f = await fixture('USDT', status); await f.apply(); expect(await f.balances()).toHaveLength(0);
    });
  }
  it('F3: a fiat-denominated order cannot become an asset credit', async () => {
    const f = await fixture(); await prisma.bankDeposit.update({ where: { id: f.deposit.id }, data: { currency: 'USD' } });
    await f.apply(); expect(await f.balances()).toHaveLength(0);
  });
  it('F1: ten same-event and distinct-event races create one balance credit and one journal entry', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 10 }, (_, i) => f.apply({}, i < 5 ? 'same-' + f.ev.providerTxId : `other-${i}-${f.ev.providerTxId}`)));
    expect((await f.balances())[0].balance.toString()).toBe('100.123456');
    expect(await prisma.journalEntry.count({ where: { entityId: f.deposit.id, entityType: 'BankDeposit' } })).toBe(1);
  });
  it('F1: an unrelated uniqueness violation propagates and does not acknowledge a lost event', async () => {
    const id = randomUUID();
    await expect(processOnce({ provider: 'fireblocks', eventId: id, rawBody: '{}' }, async () => {
      throw new Prisma.PrismaClientKnownRequestError('other unique index', { code: 'P2002', clientVersion: '7.8.0', meta: { target: ['unrelated'] } });
    })).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.providerEvent.count({ where: { eventId: id } })).toBe(0);
  });
  it('F5: competing debits cannot make the balance negative', async () => {
    const f = await fixture();
    await prisma.account.create({ data: { userId: f.user.id, currency: 'USDT', balance: 100, balanceUsd: 100 } });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_sleep(0.03)`;
      await debit(tx, f.user.id, 'USDT', '60');
    })));
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect((await f.balances())[0].balance.toString()).toBe('40');
  });
  it('F5: nonfinite or overprecision values cannot enter posting balances', async () => {
    const f = await fixture();
    for (const amount of ['Infinity', 'NaN', '0.0000001']) {
      await expect(prisma.$transaction(tx => credit(tx, f.user.id, 'USDT', amount))).rejects.toThrow();
    }
    expect(await f.balances()).toHaveLength(0);
  });
  it('F1: failure after a custody posting rolls back event, balance, deposit and journal together', async () => {
    const f = await fixture(); const eventId = randomUUID();
    await expect(processOnce({ provider: 'fireblocks', eventId, rawBody: '{}' }, async tx => {
      await applyCustodyDeposit(tx, f.ev); throw new Error('injected failure');
    })).rejects.toThrow('injected failure');
    expect(await f.balances()).toHaveLength(0);
    expect(await prisma.journalEntry.count({ where: { entityId: f.deposit.id } })).toBe(0);
    expect(await prisma.providerEvent.count({ where: { eventId } })).toBe(0);
    expect((await prisma.bankDeposit.findUniqueOrThrow({ where: { id: f.deposit.id } })).status).toBe('PENDING_FIREBLOCKS');
    await f.apply(); expect((await f.balances())[0].balance.toString()).toBe('100.123456');
  });
  it('F3: one receiving wallet keeps USDC and USDT balances and journal accounts separate', async () => {
    const f = await fixture('USDT'); await f.apply();
    const trackingId = `dep_${randomUUID()}`;
    await prisma.bankDeposit.create({ data: { userId: f.user.id, trackingId, currency: 'USDC', amount: '100.123456', usdAmount: '100.123456', usdtAmount: '100.123456', status: 'PENDING_FIREBLOCKS', bankName: 'sandbox', settlementAssetId: 'USDC_SOL' } });
    await f.apply({ providerAssetId: 'USDC_SOL', externalTxId: trackingId }, randomUUID());
    const rows = await f.balances();
    expect(rows.map(r => r.currency).sort()).toEqual(['USDC_SOL', 'USDT_SOL']);
    expect(rows.every(r => r.balance.eq('100.123456'))).toBe(true);
  });
  it('F5: signed JSON numeric amounts retain exact decimal source above safe minor units', async () => {
    const crypto = await import('crypto');
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const saved = process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY;
    process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    try {
      const amount = '9007199254.740993'; const f = await fixture('USDT', 'PENDING_FIREBLOCKS', amount);
      const raw = `{ "tenantId": "test-workspace", "type": "TRANSACTION_STATUS_UPDATED", "data": { "id": "${f.ev.providerTxId}", "status": "COMPLETED", "assetId": "USDT_SOL", "operation": "TRANSFER", "netAmount": ${amount}, "amount": ${amount}, "destination": { "type": "VAULT_ACCOUNT", "id": "${f.user.vaultId}" }, "externalTxId": "${f.deposit.trackingId}" } }`;
      const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
      const r = await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw).expect(200);
      expect(r.body.outcome).toBe('PROCESSED');
      expect((await f.balances())[0].balance.toString()).toBe(amount);
    } finally { if (saved === undefined) delete process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY; else process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = saved; }
  });
  it('F4: production institution credentials cannot access environmentless legacy records', async () => {
    const f = await fixture();
    await prisma.apiEnvironment.create({ data: { institutionId: f.inst.id, kind: 'PRODUCTION', status: 'ACTIVE' } });
    const { issueCredential } = await import('../../packages/core/institutions/institution.service');
    const key = await issueCredential(f.inst.id, 'PRODUCTION', 'live', ['*']);
    await request(app).get(`/api/users/${f.user.id}`).set('Authorization', `Bearer ${key.rawKey}`).expect(403);
  });
  it('F4: even an operator cannot invoke frozen legacy financial mutations', async () => {
    await request(app).post('/api/orchestrator/payout-rail/confirmed').set('Authorization', `Bearer ${process.env.OPS_API_KEY}`).send({}).expect(503);
    await request(app).post('/api/transfers').set('Authorization', `Bearer ${process.env.OPS_API_KEY}`).send({}).expect(503);
  });
  async function signedCallback(body: object) {
    const crypto = await import('crypto');
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const saved = process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY;
    process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    try {
      const raw = JSON.stringify(body);
      const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
      return await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw);
    } finally { if (saved === undefined) delete process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY; else process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = saved; }
  }
  function receipt(f: Awaited<ReturnType<typeof fixture>>) {
    return { id: f.ev.providerTxId, assetId: 'USDT_SOL', status: 'COMPLETED', operation: 'TRANSFER',
      amount: '100.123456', amountInfo: { amount: '100.123456', netAmount: '100.123456' },
      destination: { id: f.user.vaultId, type: 'VAULT_ACCOUNT' }, externalTxId: f.deposit.trackingId };
  }
  it('F2: a valid signature from another workspace cannot credit an AxLink deposit', async () => {
    const f = await fixture();
    const r = await signedCallback({ eventType: 'transaction.status.updated', workspaceId: 'another-workspace', data: receipt(f) });
    expect(r.status).toBe(401); expect(await f.balances()).toHaveLength(0);
    expect(await prisma.providerEvent.count({ where: { eventId: `${f.ev.providerTxId}:COMPLETED` } })).toBe(0);
  });
  it('F2: missing workspace configuration fails closed even with a valid signature', async () => {
    const f = await fixture(); const saved = process.env.FIREBLOCKS_WORKSPACE_ID; delete process.env.FIREBLOCKS_WORKSPACE_ID;
    try {
      const r = await signedCallback({ eventType: 'transaction.status.updated', workspaceId: 'test-workspace', data: receipt(f) });
      expect(r.status).toBe(503); expect(await f.balances()).toHaveLength(0);
    } finally { process.env.FIREBLOCKS_WORKSPACE_ID = saved; }
  });
  it('F3: documented V2 net receipt settles; requested amount alone never substitutes for receipt', async () => {
    const f = await fixture();
    const r = await signedCallback({ eventType: 'transaction.status.updated', workspaceId: 'test-workspace', data: receipt(f) });
    expect(r.status).toBe(200); expect(r.body.outcome).toBe('PROCESSED');
    expect((await f.balances())[0].balance.toString()).toBe('100.123456');
  });
  it('F3: requested amount matching the instruction cannot hide a smaller net receipt', async () => {
    const f = await fixture(); const data = { ...receipt(f), amountInfo: { amount: '100.123456', netAmount: '0.000001' } };
    const r = await signedCallback({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data });
    expect(r.body.outcome).toBe('REJECTED'); expect(await f.balances()).toHaveLength(0);
  });
  it('F3: a requested amount without an authenticated net receipt cannot credit', async () => {
    const f = await fixture(); const { amountInfo, ...data } = receipt(f); void amountInfo;
    const r = await signedCallback({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data });
    expect(r.body.outcome).toBe('REJECTED'); expect(await f.balances()).toHaveLength(0);
  });
  it('F3: internal wallet movement, non-transfer operation and non-vault destination cannot mint a liability', async () => {
    for (const change of [{ sourceType: 'VAULT_ACCOUNT' }, { operation: 'MINT' }, { destinationType: 'EXCHANGE_ACCOUNT' }]) {
      const f = await fixture(); const result = await f.apply(change);
      expect(result.outcome?.status).toBe('REJECTED'); expect(await f.balances()).toHaveLength(0);
    }
  });
  it('F4: institution keys cannot call legacy callbacks or mutations, even for their own user', async () => {
    const f = await fixture();
    const { issueCredential } = await import('../../packages/core/institutions/institution.service');
    const key = await issueCredential(f.inst.id, 'SANDBOX', 'read', ['*']);
    for (const path of ['/api/orchestrator/payout-rail/confirmed', '/api/orchestrator/payout-rail/fiat-arrived', '/api/users']) {
      await request(app).post(path).set('Authorization', `Bearer ${key.rawKey}`).send({}).expect(403);
    }
  });
  it('F4: empty-scope legacy reads are denied, and fiat webhook routers are disabled', async () => {
    const f = await fixture();
    const { issueCredential } = await import('../../packages/core/institutions/institution.service');
    const key = await issueCredential(f.inst.id, 'SANDBOX', 'empty', []);
    await request(app).get(`/api/users/${f.user.id}`).set('Authorization', `Bearer ${key.rawKey}`).expect(403);
    for (const path of ['/api/webhooks/brainrock/card/reversed', '/api/webhooks/daraja/b2c/result', '/api/webhooks/choicebank']) {
      await request(app).post(path).send({}).expect(503);
    }
  });
});
