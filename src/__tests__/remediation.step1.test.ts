/**
 * Step 1 security remediation — F1..F6.
 * Committed RED before the fixes; each describe block turns green in the commit that fixes it.
 * Runs against a real PostgreSQL (DATABASE_URL). No real provider calls — sandbox mode.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.B2BINPAY_CALLBACK_SECRET ??= 'b2b-test-callback-secret';

// Fireblocks signs webhooks with RSA-SHA512 over the raw body. Generate a key pair for the test.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sign = (raw: string) => crypto.sign('sha512', Buffer.from(raw), privateKey).toString('base64');

const DB = process.env.DATABASE_URL; const d = DB ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

describe('F6 · asset registry: network + contract + id + precision', () => {
  it('resolves Fireblocks asset ids to (network, contract, decimals) for both USDC and USDT', async () => {
    const r = await import('../core/assets/registry');
    const usdc = r.resolveProviderAsset('fireblocks', 'USDC_SOL'); const usdt = r.resolveProviderAsset('fireblocks', 'USDT_SOL');
    expect(usdc).toMatchObject({ id: 'USDC_SOL', symbol: 'USDC', network: 'solana-mainnet', contract: USDC_MINT, decimals: 6 });
    expect(usdt).toMatchObject({ id: 'USDT_SOL', symbol: 'USDT', network: 'solana-mainnet', contract: USDT_MINT, decimals: 6 });
  });
  it('a ticker alone is not an asset: lookup requires network + contract', async () => {
    const r = await import('../core/assets/registry');
    expect(r.resolveByContract('solana-mainnet', USDC_MINT)?.id).toBe('USDC_SOL');
    expect(r.resolveByContract('ethereum-mainnet', USDC_MINT)).toBeNull();          // wrong network
    expect(r.resolveByContract('solana-mainnet', USDC_MINT.replace('E', 'F'))).toBeNull(); // wrong mint
    expect(r.resolveProviderAsset('fireblocks', 'USDC_ETH')).toBeNull();            // unsupported network
    expect(r.resolveProviderAsset('fireblocks', 'USDC')).toBeNull();                // bare ticker
  });
  it('converts to and from integer minor units exactly', async () => {
    const r = await import('../core/assets/registry');
    const a = r.getAsset('USDC_SOL');
    expect(r.toMinorUnits('123.456789', a)).toBe(123456789n);
    expect(() => r.toMinorUnits('0.0000001', a)).toThrow(); // more precision than the asset has
    expect(r.fromMinorUnits(123456789n, a).toString()).toBe('123.456789');
  });
});

describe('F5 · exact arithmetic on posting paths', () => {
  it('credit/debit accept Decimal and never round through a JS number', async () => {
    const src = (await import('fs')).readFileSync('src/core/ledger.service.ts', 'utf8');
    expect(/Number\(account\.balance\)/.test(src)).toBe(false);
    const wh = (await import('fs')).readFileSync('src/routes/webhook.routes.ts', 'utf8');
    expect(/Number\((deposit|withdrawal)\.amount\)/.test(wh)).toBe(false);
  });
});

d('F1/F2/F3/F4 · against the live app (requires DATABASE_URL)', () => {
  let app: import('express').Express; let prisma: any;
  beforeAll(async () => { ({ app } = await import('../index')); ({ prisma } = await import('../core/ledger.service')); });

  const post = (path: string, body: object, headers: Record<string, string> = {}) => {
    const raw = JSON.stringify(body);
    return request(app).post(path).set({ 'Content-Type': 'application/json', ...headers }).send(raw);
  };
  const fbEvent = (id: string, assetId: string, vaultId: string, trackingId: string, status = 'COMPLETED') =>
    ({ type: 'TRANSACTION_STATUS_UPDATED', data: { id, status, assetId, amount: 100, destination: { id: vaultId }, externalTxId: trackingId } });
  const signed = (body: object) => ({ 'fireblocks-signature': sign(JSON.stringify(body)) });

  async function makeInstitution(tag: string) {
    const t = Date.now();
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug: `rem-${tag}-${t}`, legalName: `Remediation ${tag}`, country: 'KE', kind: 'BANK' }).expect(201);
    await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } });
    const key = await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k' }).expect(201);
    return { id: inst.body.id as string, key: key.body.apiKey as string };
  }
  async function makeDeposit(institutionId: string | null) {
    const t = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const user = await prisma.user.create({ data: { name: 'Dep', email: `dep${t}@x.io`, vaultId: `vault-${t}`, kycStatus: 'APPROVED', ...(institutionId ? { institutionId } : {}) } });
    await prisma.bankDeposit.create({ data: { trackingId: `dep_${t}`, userId: user.id, amount: new Prisma.Decimal('100.123456'), usdAmount: new Prisma.Decimal('100.123456'), usdtAmount: new Prisma.Decimal('100.123456'), currency: 'USD', bankName: 'T', status: 'PENDING_FIREBLOCKS', method: 'bank_transfer' } });
    const balance = async () => (await prisma.account.findFirst({ where: { userId: user.id, currency: 'USD' } }))?.balance?.toString() ?? '0';
    return { user, trackingId: `dep_${t}`, balance, t };
  }

  describe('F2 · webhook authentication fails closed', () => {
    it('rejects a Fireblocks event with no signature', async () => {
      const { user, trackingId, balance } = await makeDeposit(null);
      await post('/api/webhooks/fireblocks', fbEvent(`nosig-${trackingId}`, 'USDT_SOL', user.vaultId, trackingId)).expect(401);
      expect(await balance()).toBe('0');
    });
    it('rejects a Fireblocks event whose signature does not match the raw body', async () => {
      const { user, trackingId, balance } = await makeDeposit(null);
      const body = fbEvent(`badsig-${trackingId}`, 'USDT_SOL', user.vaultId, trackingId);
      const tampered = { ...body, data: { ...body.data, amount: 999 } };
      await post('/api/webhooks/fireblocks', tampered, signed(body)).expect(401);
      expect(await balance()).toBe('0');
    });
    it('rejects every event when the verification key is not configured (no dev-mode bypass)', async () => {
      const saved = process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY; delete process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY;
      try {
        const { user, trackingId, balance } = await makeDeposit(null);
        const body = fbEvent(`nokey-${trackingId}`, 'USDT_SOL', user.vaultId, trackingId);
        const r = await post('/api/webhooks/fireblocks', body, signed(body));
        expect([401, 503]).toContain(r.status);
        expect(await balance()).toBe('0');
      } finally { process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = saved; }
    });
    it('rejects a B2BinPay callback with a bad HMAC and when the secret is unset', async () => {
      await post('/api/webhooks/b2binpay', { data: { id: 'x', attributes: { status: 2 } } }, { 'x-callback-signature': 'deadbeef' }).expect(401);
      const saved = process.env.B2BINPAY_CALLBACK_SECRET; delete process.env.B2BINPAY_CALLBACK_SECRET;
      try { const r = await post('/api/webhooks/b2binpay', { data: { id: 'x', attributes: { status: 2 } } }); expect([401, 503]).toContain(r.status); }
      finally { process.env.B2BINPAY_CALLBACK_SECRET = saved; }
    });
  });

  describe('F3 · USDC and USDT deposits, attributed to institution, wallet and asset', () => {
    it('a USDC completion credits the deposit and records the asset by id/contract', async () => {
      const inst = await makeInstitution('usdc');
      const { user, trackingId, balance } = await makeDeposit(inst.id);
      const body = fbEvent(`usdc-${trackingId}`, 'USDC_SOL', user.vaultId, trackingId);
      await post('/api/webhooks/fireblocks', body, signed(body)).expect(200);
      expect(await balance()).toBe('100.123456');
      const dep = await prisma.bankDeposit.findUnique({ where: { trackingId } });
      expect(dep.status).toBe('COMPLETED'); expect(dep.settlementAssetId).toBe('USDC_SOL');
      const ev = await prisma.providerEvent.findUnique({ where: { provider_eventId: { provider: 'fireblocks', eventId: `usdc-${trackingId}:COMPLETED` } } });
      expect(ev).toMatchObject({ status: 'PROCESSED', assetId: 'USDC_SOL', institutionId: inst.id, vaultId: user.vaultId, entityType: 'BankDeposit' });
    });
    it('a USDT completion credits the deposit the same way', async () => {
      const inst = await makeInstitution('usdt');
      const { user, trackingId, balance } = await makeDeposit(inst.id);
      const body = fbEvent(`usdt-${trackingId}`, 'USDT_SOL', user.vaultId, trackingId);
      await post('/api/webhooks/fireblocks', body, signed(body)).expect(200);
      expect(await balance()).toBe('100.123456');
      expect((await prisma.bankDeposit.findUnique({ where: { trackingId } })).settlementAssetId).toBe('USDT_SOL');
    });
    it('an unsupported network (USDC on Ethereum) or unknown token is recorded as IGNORED and never credits', async () => {
      const { user, trackingId, balance } = await makeDeposit(null);
      for (const assetId of ['USDC_ETH', 'USDC_POLYGON', 'SOL', 'FAKE_SOL']) {
        const body = fbEvent(`bad-${assetId}-${trackingId}`, assetId, user.vaultId, trackingId);
        await post('/api/webhooks/fireblocks', body, signed(body)).expect(200);
      }
      expect(await balance()).toBe('0');
      expect((await prisma.bankDeposit.findUnique({ where: { trackingId } })).status).toBe('PENDING_FIREBLOCKS');
      const ev = await prisma.providerEvent.findUnique({ where: { provider_eventId: { provider: 'fireblocks', eventId: `bad-USDC_ETH-${trackingId}:COMPLETED` } } });
      expect(ev?.status).toBe('IGNORED');
    });
  });

  describe('F1 · exactly-once credit', () => {
    it('an exact replay of a processed event is acknowledged but credits nothing', async () => {
      const { user, trackingId, balance } = await makeDeposit(null);
      const body = fbEvent(`rep-${trackingId}`, 'USDT_SOL', user.vaultId, trackingId);
      await post('/api/webhooks/fireblocks', body, signed(body)).expect(200);
      const r = await post('/api/webhooks/fireblocks', body, signed(body)).expect(200);
      expect(r.body.duplicate).toBe(true);
      expect(await balance()).toBe('100.123456');
    });
    it('ten concurrent deliveries of the same event credit exactly once', async () => {
      const { user, trackingId, balance } = await makeDeposit(null);
      const body = fbEvent(`conc-${trackingId}`, 'USDT_SOL', user.vaultId, trackingId);
      const results = await Promise.all(Array.from({ length: 10 }, () => post('/api/webhooks/fireblocks', body, signed(body))));
      expect(results.every(r => r.status === 200)).toBe(true);
      expect(results.filter(r => r.body.duplicate !== true).length).toBe(1);
      expect(await balance()).toBe('100.123456');
    });
    it('a second, distinct event for an already-settled deposit does not credit again (status guard, rolled back atomically)', async () => {
      const { user, trackingId, balance } = await makeDeposit(null);
      const a = fbEvent(`first-${trackingId}`, 'USDT_SOL', user.vaultId, trackingId);
      const b = fbEvent(`second-${trackingId}`, 'USDT_SOL', user.vaultId, trackingId);
      await post('/api/webhooks/fireblocks', a, signed(a)).expect(200);
      await post('/api/webhooks/fireblocks', b, signed(b)).expect(200);
      expect(await balance()).toBe('100.123456');
      const ev = await prisma.providerEvent.findUnique({ where: { provider_eventId: { provider: 'fireblocks', eventId: `second-${trackingId}:COMPLETED` } } });
      expect(ev?.status).toBe('IGNORED');
    });
    it('a B2BinPay failure callback reverses a withdrawal exactly once', async () => {
      const t = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const user = await prisma.user.create({ data: { name: 'W', email: `w${t}@x.io`, vaultId: `vault-w-${t}`, kycStatus: 'APPROVED' } });
      await prisma.account.create({ data: { userId: user.id, currency: 'USD', balance: new Prisma.Decimal('0'), balanceUsd: new Prisma.Decimal('0') } });
      await prisma.withdrawal.create({ data: { trackingId: `out_${t}`, userId: user.id, currency: 'USD', amount: new Prisma.Decimal('50.5'), status: 'PENDING_B2BINPAY', bankName: 'T', bankAccount: '1', usdAmount: new Prisma.Decimal('50.5'), usdtAmount: new Prisma.Decimal('50.5') } });
      const body = { data: { id: `b2b-${t}`, attributes: { status: -1, tracking_id: `out_${t}` } } }; // -1 = failed (see TRANSFER_STATUS)
      const raw = JSON.stringify(body); const sig = crypto.createHmac('sha256', process.env.B2BINPAY_CALLBACK_SECRET!).update(raw).digest('hex');
      await request(app).post('/api/webhooks/b2binpay').set({ 'Content-Type': 'application/json', 'x-callback-signature': sig }).send(raw).expect(200);
      await request(app).post('/api/webhooks/b2binpay').set({ 'Content-Type': 'application/json', 'x-callback-signature': sig }).send(raw).expect(200);
      const bal = (await prisma.account.findFirst({ where: { userId: user.id, currency: 'USD' } })).balance.toString();
      expect(bal).toBe('50.5');
    });
  });

  describe('F4 · legacy customer API requires institutional authorization and is tenant-isolated', () => {
    it('unauthenticated calls are rejected on every legacy financial route', async () => {
      await request(app).post('/api/users').send({ name: 'x', email: 'x@x.io', currency: 'USD' }).expect(401);
      await request(app).get('/api/users/any').expect(401);
      await request(app).post('/api/transfers').send({}).expect(401);
      await request(app).post('/api/withdrawals').send({}).expect(401);
      await request(app).post('/api/deposits/initiate').send({}).expect(401);
      await request(app).get('/api/deposits?userId=x').expect(401);
      await request(app).post('/api/orchestrator/withdraw').send({}).expect(401);
      await request(app).post('/api/orchestrator/payout-rail/fiat-arrived').send({}).expect(401);
      await request(app).post('/api/quote').send({}).expect(401);
    });
    it('institution A cannot read or move institution B customers; ops key keeps full access', async () => {
      const A = await makeInstitution('a'); const B = await makeInstitution('b');
      const ua = await request(app).post('/api/users').set('Authorization', `Bearer ${A.key}`).send({ name: 'UA', email: `ua${Date.now()}@x.io`, currency: 'USD' }).expect(201);
      const ub = await request(app).post('/api/users').set('Authorization', `Bearer ${B.key}`).send({ name: 'UB', email: `ub${Date.now()}@x.io`, currency: 'USD' }).expect(201);
      expect((await prisma.user.findUnique({ where: { id: ua.body.userId } })).institutionId).toBe(A.id);
      await request(app).get(`/api/users/${ua.body.userId}`).set('Authorization', `Bearer ${A.key}`).expect(200);
      await request(app).get(`/api/users/${ub.body.userId}`).set('Authorization', `Bearer ${A.key}`).expect(404);
      await request(app).get(`/api/users/${ub.body.userId}/balance/USD`).set('Authorization', `Bearer ${A.key}`).expect(404);
      await request(app).get(`/api/deposits?userId=${ub.body.userId}`).set('Authorization', `Bearer ${A.key}`).expect(404);
      await request(app).post('/api/transfers').set('Authorization', `Bearer ${A.key}`).send({ senderId: ua.body.userId, receiverId: ub.body.userId, fromCurrency: 'USD', toCurrency: 'USD', amount: 1 }).expect(404);
      await request(app).post('/api/orchestrator/payout-rail/fiat-arrived').set('Authorization', `Bearer ${A.key}`).send({ userId: ub.body.userId, currency: 'USD', amount: 10, rail: 'mpesa', railReference: 'r' }).expect(404);
      await request(app).get(`/api/users/${ub.body.userId}`).set(ops).expect(200);
    });
  });

  describe('rollback · a failure after the credit leaves no partial state', () => {
    it('credit + deposit update + event record commit or roll back together', async () => {
      const { user, trackingId, balance } = await makeDeposit(null);
      // Force the deposit to COMPLETED underneath a fresh event: the status guard throws inside the
      // transaction after credit() has run; the credit must not survive.
      await prisma.bankDeposit.update({ where: { trackingId }, data: { status: 'COMPLETED' } });
      const body = fbEvent(`rb-${trackingId}`, 'USDT_SOL', user.vaultId, trackingId);
      await post('/api/webhooks/fireblocks', body, signed(body)).expect(200);
      expect(await balance()).toBe('0');
    });
  });
});
