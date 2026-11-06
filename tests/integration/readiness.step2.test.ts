/**
 * Step 2 · slice 7 — production readiness: velocity limits, sanctions screening on external
 * addresses, explicit settlement wallet, production configuration gates. Requires DATABASE_URL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto, { randomUUID } from 'crypto';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.FIREBLOCKS_WORKSPACE_ID = 'test-workspace';
process.env.WEBHOOK_ALLOW_INSECURE_URLS = 'true';
process.env.SIMULATOR_ENABLED = 'true';
const BLOCKED = 'B1ockedB1ockedB1ockedB1ockedB1ockedB1ockedB1';
const REVIEW = 'Rev1ewRev1ewRev1ewRev1ewRev1ewRev1ewRev1ewRe';
process.env.SCREENING_DENYLIST = `${BLOCKED}:BLOCKED,${REVIEW}:REVIEW`;
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const db = process.env.DATABASE_URL ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };
const ALL = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'webhooks:write', 'webhooks:read', 'ledger:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write'];
const ADDR = () => crypto.randomBytes(32).toString('hex').replace(/[0lIO]/g, 'a').slice(0, 44);
const key = () => `idem-${randomUUID()}`;

db('production readiness', () => {
  let app: import('express').Express; let prisma: any;
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service')); });
  async function institution(tag: string) {
    const id = randomUUID().slice(0, 8); const slug = `rd-${tag}-${id}`;
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug, legalName: `Rd ${tag}`, country: 'KE', kind: 'BANK' }).expect(201);
    await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } });
    const k = await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes: ALL }).expect(201);
    const auth = { Authorization: `Bearer ${k.body.apiKey}` };
    const wallet = (await request(app).post('/api/v1/wallets').set(auth).send({ label: 'Main' }).expect(201)).body;
    return { id: inst.body.id as string, slug, auth, wallet };
  }
  async function fund(A: { auth: any; wallet: any }, asset: 'USDC_SOL' | 'USDT_SOL', amount: number) {
    const d = (await request(app).post('/api/v1/deposits').set(A.auth).send({ walletId: A.wallet.id, asset, amount: String(amount) }).expect(201)).body;
    const raw = JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data: { id: `fb-${randomUUID()}`, status: 'COMPLETED', assetId: asset, operation: 'TRANSFER', netAmount: amount, amount, txHash: `sig${randomUUID().replace(/-/g, '')}`, destination: { type: 'VAULT_ACCOUNT', id: A.wallet.custody.vaultId }, source: { type: 'EXTERNAL_WALLET' }, externalTxId: d.trackingId } });
    const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
    await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw).expect(200);
  }

  it('screening: BLOCKED is refused, REVIEW waits for an operator even in sandbox, CLEAR is recorded; the verdict shows on the counterparty', async () => {
    const A = await institution('scr');
    expect((await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Bad', address: BLOCKED }).expect(400)).body.error.code).toBe('ADDRESS_BLOCKED');
    expect(await prisma.counterparty.count({ where: { address: BLOCKED } })).toBe(0);
    const rv = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Maybe', address: REVIEW }).expect(201)).body;
    expect(rv).toMatchObject({ status: 'PENDING_APPROVAL', screening: { verdict: 'REVIEW', provider: 'screening-stub' } });
    const ok = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Fine', address: ADDR() }).expect(201)).body;
    expect(ok).toMatchObject({ status: 'ACTIVE', screening: { verdict: 'CLEAR' } });
    // production refuses unscreened external addresses when no provider is configured
    const { registerCounterparty } = await import('../../packages/settlement/transfers/counterparty.service');
    const env = await prisma.apiEnvironment.findFirst({ where: { institutionId: A.id, kind: 'PRODUCTION' } });
    await expect(registerCounterparty({ institutionId: A.id, environmentId: env.id, environmentKind: 'PRODUCTION' }, { label: 'P', address: ADDR() })).rejects.toMatchObject({ code: 'SCREENING_UNAVAILABLE' });
    process.env.SCREENING_OPTIONAL = 'true';
    try { expect((await registerCounterparty({ institutionId: A.id, environmentId: env.id, environmentKind: 'PRODUCTION' }, { label: 'P', address: ADDR() })).status).toBe('PENDING_APPROVAL'); } finally { delete process.env.SCREENING_OPTIONAL; }
    // network participants are not screened (the destination is AxLink custody)
    const B = await institution('scr2');
    expect((await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'B', participant: B.slug }).expect(201)).body.screening).toBeNull();
  });

  it('velocity: daily limit per environment and asset, per-hour count, operator overrides; refusals leave nothing posted', async () => {
    const A = await institution('vel'); await fund(A, 'USDC_SOL', 10_000_000);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'X', address: ADDR() }).expect(201)).body;
    const mk = (amount: string) => request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount });
    // operator lowers this environment's daily limit to 100 and the hourly count to 3
    const pol = await request(app).patch(`/api/institutions/${A.id}/environments/sandbox/policy`).set(ops).send({ transferDailyLimit: '100', transferMaxPerHour: 3 }).expect(200);
    expect(pol.body.policy).toMatchObject({ transferDailyLimit: '100', transferMaxPerHour: 3 });
    await request(app).patch(`/api/institutions/${A.id}/environments/prod/policy`).set(ops).send({}).expect(400);
    await request(app).patch(`/api/institutions/${A.id}/environments/sandbox/policy`).send({}).expect(401);
    await mk('60').expect(202);
    const over = await mk('50').expect(422); expect(over.body.error.code).toBe('POLICY_DAILY_LIMIT'); expect(over.body.error.details.sentToday).toBe('60');
    await mk('40').expect(202);
    await mk('1').expect(422); // daily cap reached exactly
    // raise the daily limit; the hourly count (2 created) still applies: third ok, fourth refused with 429
    await request(app).patch(`/api/institutions/${A.id}/environments/sandbox/policy`).set(ops).send({ transferDailyLimit: null }).expect(200);
    await mk('1').expect(202);
    const vel = await mk('1').expect(429); expect(vel.body.error.code).toBe('POLICY_VELOCITY');
    expect((await request(app).get('/api/v1/balances').set(A.auth)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('9999899');
    // concurrent creates cannot both squeeze under a cap
    await request(app).patch(`/api/institutions/${A.id}/environments/sandbox/policy`).set(ops).send({ transferDailyLimit: '200', transferMaxPerHour: 100 }).expect(200);
    const rs = await Promise.all([1, 2, 3].map(() => mk('60')));
    expect(rs.map(r => r.status).sort()).toEqual([202, 422, 422]); // 101 already today + 60 = 161; a second 60 would be 221
  });

  it('settlement wallet: the institution designates which wallet receives network settlements; operator can set it too; a non-active one is refused', async () => {
    const A = await institution('sw'); const B = await institution('sw2');
    const w2 = (await request(app).post('/api/v1/wallets').set(B.auth).send({ label: 'Settlement' }).expect(201)).body;
    const { settlementWalletFor } = await import('../../packages/settlement/transfers/counterparty.service');
    expect((await settlementWalletFor(B.id, 'SANDBOX'))!.id).toBe(B.wallet.id); // default: oldest
    await request(app).post(`/api/v1/wallets/${w2.id}/settlement-default`).set(B.auth).expect(200);
    expect((await settlementWalletFor(B.id, 'SANDBOX'))!.id).toBe(w2.id);
    await request(app).post(`/api/v1/wallets/${w2.id}/settlement-default`).set(A.auth).expect(404); // not A's wallet
    await prisma.wallet.update({ where: { id: w2.id }, data: { status: 'SUSPENDED' } });
    expect((await settlementWalletFor(B.id, 'SANDBOX'))!.id).toBe(B.wallet.id); // designated but suspended → falls back
    await request(app).post(`/api/v1/wallets/${w2.id}/settlement-default`).set(B.auth).expect(409);
    await request(app).patch(`/api/institutions/${B.id}/environments/sandbox/policy`).set(ops).send({ settlementWalletId: w2.id }).expect(404);
    await request(app).patch(`/api/institutions/${B.id}/environments/sandbox/policy`).set(ops).send({ settlementWalletId: B.wallet.id }).expect(200);
  });

  it('production configuration refuses the public Solana endpoint, malformed limits and an unspecified screening choice is only warned', async () => {
    const { loadConfig, ConfigError } = await import('../../packages/shared/config');
    const base: NodeJS.ProcessEnv = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x', OPS_API_KEY: 'k'.repeat(24), FIREBLOCKS_WORKSPACE_ID: 'ws-real', WEBHOOK_ENCRYPTION_KEY: 'a'.repeat(64), FIREBLOCKS_WEBHOOK_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----', SOLANA_RPC_URL: 'https://my-node.example.com', API_BASE_URL: 'https://api.axlink.network/api' };
    expect(() => loadConfig(base)).not.toThrow();
    const bad = () => loadConfig({ ...base, SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com', TRANSFER_DAILY_LIMIT: '-5', OUTBOUND_SETTLEMENT_ENABLED: 'yes' });
    expect(bad).toThrow(ConfigError);
    try { bad(); } catch (e) { const p = (e as InstanceType<typeof ConfigError>).problems.join('\n'); expect(p).toMatch(/dedicated node/); expect(p).toMatch(/TRANSFER_DAILY_LIMIT/); expect(p).toMatch(/OUTBOUND_SETTLEMENT_ENABLED/); }
  });
});
