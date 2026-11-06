/**
 * Step 2 · slice 5 — outbound settlement: counterparties, policy, approval, journal reservation,
 * custody submission through the port, custody status (webhook + poll), Solana finality proof,
 * reversal on failure, transfer.* webhooks. Requires DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import http from 'http';
import crypto, { randomUUID } from 'crypto';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.FIREBLOCKS_WORKSPACE_ID = 'test-workspace';
process.env.WEBHOOK_ALLOW_INSECURE_URLS = 'true';
process.env.SIMULATOR_ENABLED = 'true';
process.env.TRANSFER_AUTO_APPROVE_LIMIT_SANDBOX = '1000';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const db = process.env.DATABASE_URL ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };
const CP_ADDR = () => crypto.randomBytes(32).toString('hex').replace(/[0lIO]/g, 'a').slice(0, 44); // base58-looking, valid length
const ALL = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'webhooks:write', 'webhooks:read', 'ledger:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write'];

db('outbound settlement transfers', () => {
  let app: import('express').Express; let prisma: any; let svc: typeof import('../../packages/settlement/transfers/settlement-transfer.service');
  let reg: typeof import('../../packages/providers/registry/provider-registry'); let fbAdapter: any; let outbox: typeof import('../../packages/core/events/outbox.service');
  const received: { headers: http.IncomingHttpHeaders; body: any }[] = [];
  let hookServer: http.Server; let hookUrl: string;
  beforeAll(async () => {
    ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service'));
    svc = await import('../../packages/settlement/transfers/settlement-transfer.service');
    reg = await import('../../packages/providers/registry/provider-registry');
    ({ fireblocksCustodyProvider: fbAdapter } = await import('../../packages/providers/custody/fireblocks/fireblocks.custody-provider'));
    outbox = await import('../../packages/core/events/outbox.service');
    hookServer = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { received.push({ headers: req.headers, body: JSON.parse(b) }); res.statusCode = 200; res.end(); }); });
    await new Promise<void>(r => hookServer.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hookServer.address() as { port: number }).port}/hook`;
  });
  afterAll(() => hookServer.close());
  afterEach(() => { reg.registerCustodyProvider(fbAdapter); });

  async function institution(tag: string, scopes = ALL) {
    const id = randomUUID().slice(0, 8);
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug: `tr-${tag}-${id}`, legalName: `Tr ${tag}`, country: 'KE', kind: 'BANK' }).expect(201);
    await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } });
    const key = await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes }).expect(201);
    const auth = { Authorization: `Bearer ${key.body.apiKey}` };
    const w = (await request(app).post('/api/v1/wallets').set(auth).send({ label: 'Main' }).expect(201)).body;
    if (scopes.includes('webhooks:write')) await request(app).post('/api/v1/webhook-endpoints').set(auth).send({ url: hookUrl }).expect(201);
    return { id: inst.body.id as string, auth, wallet: w };
  }
  /** Fund a wallet by settling a deposit through the signed Fireblocks path (the only way money enters). */
  async function fund(A: { auth: any; wallet: any }, asset: 'USDC_SOL' | 'USDT_SOL', amount: number) {
    const d = (await request(app).post('/api/v1/deposits').set(A.auth).send({ walletId: A.wallet.id, asset, amount: String(amount) }).expect(201)).body;
    const raw = JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data: { id: `fb-${randomUUID()}`, status: 'COMPLETED', assetId: asset, operation: 'TRANSFER', netAmount: amount, amount, txHash: `sig${randomUUID().replace(/-/g, '')}`, destination: { type: 'VAULT_ACCOUNT', id: A.wallet.custody.vaultId }, source: { type: 'EXTERNAL_WALLET' }, externalTxId: d.trackingId } });
    const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
    await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw).expect(200);
  }
  const key = () => `idem-${randomUUID()}`;
  const events = (transferId: string) => received.filter(r => r.body.data?.transferId === transferId).map(r => r.body.type);

  it('end to end in sandbox: counterparty auto-active → transfer auto-approved → journaled → submitted → confirmed → SETTLED (SANDBOX_SIMULATED); balances and ledger agree; webhooks delivered', async () => {
    const A = await institution('e2e');
    await fund(A, 'USDC_SOL', 500);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Partner Bank', address: CP_ADDR() }).expect(201)).body;
    expect(cp.status).toBe('ACTIVE');
    const t = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '120.5', reference: 'SETTLE-1' }).expect(202)).body;
    expect(t).toMatchObject({ kind: 'TRANSFER', status: 'PROCESSING', stage: 'APPROVED', amount: '120.5' });
    expect(t.approval.by).toBe('sandbox-auto');
    // journaled at APPROVED: custody − / institution +
    let bal = (await request(app).get('/api/v1/balances').set(A.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL');
    expect(bal.available).toBe('379.5');
    const entries = (await request(app).get(`/api/v1/ledger/entries?entityId=${t.id}`).set(A.auth).expect(200)).body.entries;
    expect(entries).toHaveLength(1); expect(entries[0].eventType).toBe('SETTLEMENT');
    expect(entries[0].lines.map((l: any) => [l.account.split(':')[0], l.amount]).sort()).toEqual([['CUSTODY', '-120.5'], ['INSTITUTION', '120.5']]);

    await svc.runTransferSweep();
    const done = (await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth).expect(200)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', stage: 'SETTLED' }); expect(done.proof.finality).toBe('SANDBOX_SIMULATED'); expect(done.proof.custodyTxId).toMatch(/_sandbox_/);
    expect((await request(app).get(`/api/v1/settlements/${t.id}`).set(A.auth).expect(200)).body.id).toBe(t.id); // blueprint alias
    await outbox.drain(100, { entityId: t.id });
    await new Promise(r => setTimeout(r, 100));
    expect(events(t.id)).toEqual(expect.arrayContaining(['transfer.submitted', 'transfer.settled']));
    const settled = received.find(r => r.body.type === 'transfer.settled' && r.body.data.transferId === t.id)!;
    expect(settled.body.data).toMatchObject({ status: 'COMPLETED', finality: 'SANDBOX_SIMULATED', counterpartyAddress: cp.address, amount: '120.5', reference: 'SETTLE-1' });
    expect(String(settled.headers['x-axlink-signature'])).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    // replay with the same Idempotency-Key → same transfer, 200; different body under the key → 409
    const k2 = key();
    const first = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', k2).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '1' }).expect(202)).body;
    expect((await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', k2).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '1' }).expect(200)).body.id).toBe(first.id);
    expect((await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', k2).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '2' }).expect(409)).body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    await request(app).post('/api/v1/transfers').set(A.auth).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '1' }).expect(400); // no key
  });

  it('policy: insufficient balance, per-transfer limit, inactive/other-tenant counterparty, own-wallet address refused, wrong network asset', async () => {
    const A = await institution('pol'); const B = await institution('polb');
    await fund(A, 'USDT_SOL', 50);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'X', address: CP_ADDR() }).expect(201)).body;
    const cpB = (await request(app).post('/api/v1/counterparties').set(B.auth).send({ label: 'Y', address: CP_ADDR() }).expect(201)).body;
    const mk = (over: Record<string, unknown>) => request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDT_SOL', amount: '10', ...over });
    expect((await mk({ amount: '50.000001' }).expect(422)).body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await mk({ amount: '2000000' }).expect(422)).body.error.code).toBe('POLICY_LIMIT');
    expect((await mk({ counterpartyId: cpB.id }).expect(404)).body.error.code).toBe('NOT_FOUND'); // another tenant's counterparty does not exist for A
    expect((await mk({ asset: 'USDC_SOL' }).expect(422)).body.error.code).toBe('INSUFFICIENT_BALANCE'); // no USDC funded
    await request(app).delete(`/api/v1/counterparties/${cp.id}`).set(A.auth).expect(204);
    expect((await mk({}).expect(409)).body.error.code).toBe('COUNTERPARTY_NOT_ACTIVE');
    const ownAddr = CP_ADDR(); await prisma.wallet.update({ where: { id: B.wallet.id }, data: { depositAddress: ownAddr } }); // stub addresses are not base58; give B a real-shaped one
    expect((await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Me', address: ownAddr }).expect(400)).body.error.code).toBe('ADDRESS_IS_AXLINK_WALLET');
    expect((await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Bad', address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }).expect(400)).body.error.code).toBe('INVALID_ADDRESS');
    expect((await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Dup', address: cp.address }).expect(409)).body.error.code).toBe('COUNTERPARTY_EXISTS');
    // scopes: a key without transfers:write cannot create; settlements:write is accepted as the blueprint alias
    const ro = await institution('ro', ['wallets:read', 'wallets:write', 'transfers:read']);
    await request(app).post('/api/v1/transfers').set(ro.auth).set('Idempotency-Key', key()).send({ walletId: ro.wallet.id, counterpartyId: cp.id, asset: 'USDT_SOL', amount: '1' }).expect(403);
    await request(app).get('/api/v1/transfers').set(ro.auth).expect(200);
  });

  it('approval: above the sandbox auto-limit a transfer waits (reserved, not posted); operator approves → posted; reject restores; cancel by institution', async () => {
    const A = await institution('appr');
    await fund(A, 'USDC_SOL', 5000);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Big', address: CP_ADDR() }).expect(201)).body;
    const big = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '3000' }).expect(202)).body;
    expect(big).toMatchObject({ status: 'PROCESSING', stage: 'AWAITING_APPROVAL', approval: { required: true } });
    // reserved: journal untouched, but a second 3000 does not fit
    expect((await request(app).get('/api/v1/balances').set(A.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('5000');
    expect((await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '3000' }).expect(422)).body.error.code).toBe('INSUFFICIENT_BALANCE');
    const pending = await request(app).get('/api/settlement/transfers/pending').set(ops).expect(200);
    expect(pending.body.map((p: any) => p.id)).toContain(big.id);
    await request(app).get('/api/settlement/transfers/pending').expect(401);
    const approved = (await request(app).post(`/api/settlement/transfers/${big.id}/approve`).set(ops).send({ by: 'ahmed' }).expect(200)).body;
    expect(approved.stage).toBe('APPROVED'); expect(approved.approval.by).toBe('operator:ahmed');
    expect((await request(app).get('/api/v1/balances').set(A.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('2000');
    await request(app).post(`/api/settlement/transfers/${big.id}/approve`).set(ops).send({}).expect(409);

    const big2 = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '1500' }).expect(202)).body;
    const rejected = (await request(app).post(`/api/settlement/transfers/${big2.id}/reject`).set(ops).send({ reason: 'not today' }).expect(200)).body;
    expect(rejected).toMatchObject({ status: 'FAILED', stage: 'REJECTED', attention: true });
    const big3 = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '1500' }).expect(202)).body;
    expect((await request(app).post(`/api/v1/transfers/${big3.id}/cancel`).set(A.auth).expect(200)).body.stage).toBe('CANCELLED');
    expect((await request(app).post(`/api/v1/transfers/${big.id}/cancel`).set(A.auth).expect(409)).body.error.code).toBe('NOT_CANCELLABLE');
    expect((await request(app).get('/api/v1/balances').set(A.auth).expect(200)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('2000');
  });

  it('through a real-shaped custody adapter: SUBMITTED → custody webhook CONFIRMED with txHash → Solana finality proven → SETTLED (ON_CHAIN_FINALIZED); custody failure reverses the journal', async () => {
    const A = await institution('chain');
    await fund(A, 'USDC_SOL', 100);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Chain', address: CP_ADDR() }).expect(201)).body;
    const { useTestPorts } = await import('../../packages/providers/ports/runtime');
    const { ASSETS } = await import('../../packages/core/assets/registry');
    const calls: any[] = [];
    reg.registerCustodyProvider({ ...fbAdapter, transferExternal: async (p: any) => { calls.push(p); return { providerTxId: `fbout-${p.clientRef}`, status: 'PENDING' as const }; }, getTransfer: async () => ({ status: 'PENDING' as const, final: false }) });
    const t = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '40' }).expect(202)).body;
    await svc.submitApprovedTransfers();
    const mine = calls.filter(c => c.clientRef === t.id); expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ clientRef: t.id, toAddress: cp.address, amount: '40', asset: { symbol: 'USDC', chain: 'solana-mainnet' } });
    expect((await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth)).body.stage).toBe('SUBMITTED');
    await svc.pollSubmittedTransfers(); // still pending at custody
    expect((await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth)).body.stage).toBe('SUBMITTED');

    // custody webhook: completed, with the chain signature; outbound events have source VAULT_ACCOUNT
    const sig = `sig${randomUUID().replace(/-/g, '')}`;
    const raw = JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data: { id: `fbout-${t.id}`, status: 'COMPLETED', assetId: 'USDC_SOL', operation: 'TRANSFER', amount: 40, netAmount: 40, txHash: sig, source: { type: 'VAULT_ACCOUNT', id: A.wallet.custody.vaultId }, destination: { type: 'ONE_TIME_ADDRESS' } } });
    const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
    const r1 = await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw).expect(200);
    expect(r1.body).toMatchObject({ outbound: true, outcome: 'PROCESSED' });
    expect((await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw).expect(200)).body.duplicate).toBe(true);
    let cur = (await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth)).body;
    expect(cur.stage).toBe('CONFIRMED'); expect(cur.proof).toMatchObject({ txHash: sig, finality: 'CUSTODY_CONFIRMED' });

    // chain says finalized with 40 USDC moving to the counterparty → SETTLED with an on-chain proof
    const restore = useTestPorts({ chain: {
      awaitFinality: async (s: string) => ({ signature: s, found: true, slot: 4242, confirmations: null, commitment: 'finalized', err: null }),
      getTransaction: async (s: string) => ({ signature: s, slot: 4242, blockTime: new Date(), feeLamports: 5000n, err: null, tokenTransfers: [{ mint: ASSETS.USDC_SOL.contract, owner: cp.address, decimals: 6, changeRaw: 40_000_000n }, { mint: ASSETS.USDC_SOL.contract, owner: A.wallet.depositAddress, decimals: 6, changeRaw: -40_000_000n }] }),
    } as any });
    try { await svc.finalizeConfirmedTransfers(); } finally { restore(); }
    cur = (await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth)).body;
    expect(cur).toMatchObject({ status: 'COMPLETED', stage: 'SETTLED' }); expect(cur.proof).toMatchObject({ finality: 'ON_CHAIN_FINALIZED', slot: '4242', explorerUrl: `https://solscan.io/tx/${sig}` });
    const pub = await request(app).get(`/api/settlement/proof/SettlementTransfer/${t.id}`).expect(200); // public proof, no key
    expect(JSON.stringify(pub.body)).toContain(sig);

    // a second transfer fails at custody → FAILED, journal reversed, balance restored
    const t2 = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '25' }).expect(202)).body;
    expect((await request(app).get('/api/v1/balances').set(A.auth)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('35');
    await svc.submitApprovedTransfers();
    reg.registerCustodyProvider({ ...fbAdapter, getTransfer: async () => ({ status: 'FAILED' as const, final: true }) });
    await svc.pollSubmittedTransfers();
    const failed = (await request(app).get(`/api/v1/transfers/${t2.id}`).set(A.auth)).body;
    expect(failed).toMatchObject({ status: 'FAILED', stage: 'FAILED', attention: true });
    expect((await request(app).get('/api/v1/balances').set(A.auth)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('60');
    const ledger = (await request(app).get(`/api/v1/ledger/entries?entityId=${t2.id}`).set(A.auth)).body.entries;
    expect(ledger).toHaveLength(2); expect(ledger.some((e: any) => e.reversesId)).toBe(true);
    await outbox.drain(100, { entityId: t2.id }); await new Promise(r => setTimeout(r, 100));
    expect(events(t2.id)).toContain('transfer.failed');
  });

  it('custody submission retries with backoff and fails terminally after the attempt limit, reversing the journal', async () => {
    const A = await institution('retry');
    await fund(A, 'USDT_SOL', 10);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'R', address: CP_ADDR() }).expect(201)).body;
    reg.registerCustodyProvider({ ...fbAdapter, transferExternal: async () => { throw new Error('custody 503'); } });
    const t = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDT_SOL', amount: '4' }).expect(202)).body;
    const r = await svc.submitApprovedTransfers(); expect(r.deferred).toBe(1);
    let row = await prisma.settlementTransfer.findUnique({ where: { id: t.id } });
    expect(row.status).toBe('APPROVED'); expect(row.attempts).toBe(1); expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect((await svc.submitApprovedTransfers()).submitted + (await svc.submitApprovedTransfers()).deferred).toBe(0); // not due yet
    for (let i = 0; i < 4; i++) { await prisma.settlementTransfer.update({ where: { id: t.id }, data: { nextAttemptAt: new Date(0) } }); await svc.submitApprovedTransfers(); }
    row = await prisma.settlementTransfer.findUnique({ where: { id: t.id } });
    expect(row.status).toBe('FAILED'); expect(row.attempts).toBe(5);
    expect((await request(app).get('/api/v1/balances').set(A.auth)).body.balances.find((b: any) => b.asset === 'USDT_SOL').available).toBe('10');
  });

  it('review fixes: concurrent creates cannot overdraw; a disabled counterparty is refused at approval and at submission; wrong recipient is not a proof', async () => {
    const A = await institution('race');
    await fund(A, 'USDC_SOL', 100);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'R', address: CP_ADDR() }).expect(201)).body;
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '80' })));
    expect(rs.map(r => r.status).sort()).toEqual([202, 422, 422, 422, 422]);
    expect((await request(app).get('/api/v1/balances').set(A.auth)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('20');
    const { journalBalance } = await import('../../packages/core/wallets/wallet.service');
    expect((await journalBalance({ custodyVaultId: A.wallet.custody.vaultId }, 'USDC_SOL')).isNegative()).toBe(false);

    // above the auto limit → waits; counterparty disabled meanwhile → operator approval refused
    const B = await institution('dis'); await fund(B, 'USDC_SOL', 5000);
    const cpB = (await request(app).post('/api/v1/counterparties').set(B.auth).send({ label: 'D', address: CP_ADDR() }).expect(201)).body;
    const big = (await request(app).post('/api/v1/transfers').set(B.auth).set('Idempotency-Key', key()).send({ walletId: B.wallet.id, counterpartyId: cpB.id, asset: 'USDC_SOL', amount: '3000' }).expect(202)).body;
    await request(app).delete(`/api/v1/counterparties/${cpB.id}`).set(B.auth).expect(204);
    expect((await request(app).post(`/api/settlement/transfers/${big.id}/approve`).set(ops).send({}).expect(409)).body.error.code).toBe('COUNTERPARTY_NOT_ACTIVE');
    // approved, then counterparty disabled before the sweeper submits → refused before custody, journal restored
    const cpC = (await request(app).post('/api/v1/counterparties').set(B.auth).send({ label: 'C', address: CP_ADDR() }).expect(201)).body;
    const t = (await request(app).post('/api/v1/transfers').set(B.auth).set('Idempotency-Key', key()).send({ walletId: B.wallet.id, counterpartyId: cpC.id, asset: 'USDC_SOL', amount: '10' }).expect(202)).body;
    expect(t.stage).toBe('APPROVED');
    await request(app).delete(`/api/v1/counterparties/${cpC.id}`).set(B.auth).expect(204);
    const calls: any[] = []; reg.registerCustodyProvider({ ...fbAdapter, transferExternal: async (p: any) => { calls.push(p); return { providerTxId: 'x', status: 'PENDING' as const }; } });
    await svc.submitApprovedTransfers();
    expect(calls.filter(c => c.clientRef === t.id)).toHaveLength(0);
    expect((await request(app).get(`/api/v1/transfers/${t.id}`).set(B.auth)).body).toMatchObject({ stage: 'FAILED', attention: true });
    expect((await request(app).get('/api/v1/balances').set(B.auth)).body.balances.find((b: any) => b.asset === 'USDC_SOL').available).toBe('5000');

    // proof: right amount to the WRONG owner is a mismatch
    const { proveSettlement } = await import('../../packages/settlement/proof/proof.service');
    const { useTestPorts } = await import('../../packages/providers/ports/runtime');
    const { ASSETS } = await import('../../packages/core/assets/registry');
    const restore = useTestPorts({ chain: {
      awaitFinality: async (s: string) => ({ signature: s, found: true, slot: 1, confirmations: null, commitment: 'finalized', err: null }),
      getTransaction: async (s: string) => ({ signature: s, slot: 1, blockTime: new Date(), feeLamports: 1n, err: null, tokenTransfers: [{ mint: ASSETS.USDC_SOL.contract, owner: 'SomeoneElse111111111111111111111111111111111', decimals: 6, changeRaw: 10_000_000n }] }),
    } as any });
    try { await expect(proveSettlement({ entityType: 'Test', entityId: `w-${randomUUID()}`, signature: `sig-${randomUUID()}`, asset: 'USDC_SOL', expectedAmount: '10', toAddress: cpC.address, requireRecipient: true })).rejects.toThrow(/moved no USDC .* to /); } finally { restore(); }
  });

  it('review fixes: a timed-out submission is recovered from the custodian by transfer id (never paid twice, never reversed); FAILED after broadcast is flagged, not reversed; stub ids refused on a configured workspace', async () => {
    const A = await institution('rec'); await fund(A, 'USDT_SOL', 50);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Rec', address: CP_ADDR() }).expect(201)).body;
    let submits = 0;
    const held = new Map<string, { providerTxId: string; status: 'PENDING' | 'CONFIRMED' | 'FAILED'; final: boolean; txHash?: string }>();
    reg.registerCustodyProvider({ ...fbAdapter,
      transferExternal: async (p: any) => { submits++; held.set(p.clientRef, { providerTxId: `fb-${p.clientRef}`, status: 'PENDING', final: false }); throw Object.assign(new Error('gateway timeout'), { retryable: true }); },
      findTransferByClientRef: async (ref: string) => held.get(ref) ?? null,
      getTransfer: async (id: string) => [...held.values()].find(h => h.providerTxId === id) ?? { status: 'PENDING' as const, final: false },
    });
    const t = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDT_SOL', amount: '20' }).expect(202)).body;
    expect((await svc.submitApprovedTransfers()).deferred).toBe(1); // custodian accepted but we timed out
    await prisma.settlementTransfer.update({ where: { id: t.id }, data: { nextAttemptAt: new Date(0) } });
    await svc.submitApprovedTransfers();
    expect(submits).toBe(1); // recovered by externalTxId, not resubmitted
    let cur = (await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth)).body;
    expect(cur.stage).toBe('SUBMITTED'); expect(cur.proof.custodyTxId).toBe(`fb-${t.id}`);
    expect((await request(app).get('/api/v1/balances').set(A.auth)).body.balances.find((b: any) => b.asset === 'USDT_SOL').available).toBe('30');

    // custody later says FAILED but with a txHash (broadcast happened): attention, no reversal
    held.set(t.id, { providerTxId: `fb-${t.id}`, status: 'FAILED', final: true, txHash: 'sigbroadcast' });
    await svc.pollSubmittedTransfers();
    cur = (await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth)).body;
    expect(cur.stage).toBe('SUBMITTED'); expect(cur.attention).toBe(true); expect(cur.reason).toMatch(/after broadcast/);
    expect((await request(app).get('/api/v1/balances').set(A.auth)).body.balances.find((b: any) => b.asset === 'USDT_SOL').available).toBe('30');

    // a "configured" custodian answering a sandbox id is refused (not recorded as confirmed)
    reg.registerCustodyProvider({ ...fbAdapter, configured: () => true, findTransferByClientRef: async () => null });
    const sv = process.env.FIREBLOCKS_SANDBOX; process.env.FIREBLOCKS_SANDBOX = 'true'; // keep custodyEnvironmentKind SANDBOX for wallet gating
    try {
      const t2 = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDT_SOL', amount: '5' }).expect(202)).body;
      await svc.submitApprovedTransfers();
      const row = await prisma.settlementTransfer.findUnique({ where: { id: t2.id } });
      expect(row.status).toBe('FAILED'); expect(row.failureReason).toMatch(/sandbox transaction id/);
      expect((await request(app).get('/api/v1/balances').set(A.auth)).body.balances.find((b: any) => b.asset === 'USDT_SOL').available).toBe('30');
    } finally { if (sv === undefined) delete process.env.FIREBLOCKS_SANDBOX; else process.env.FIREBLOCKS_SANDBOX = sv; }
  });

  it('PRODUCTION: outbound is disabled unless OUTBOUND_SETTLEMENT_ENABLED=true; counterparties need an operator attestation', async () => {
    expect(svc.outboundEnabled('PRODUCTION')).toBe(false); expect(svc.outboundEnabled('SANDBOX')).toBe(true);
    const { registerCounterparty, approveCounterparty } = await import('../../packages/settlement/transfers/counterparty.service');
    const A = await institution('prod');
    const env = await prisma.apiEnvironment.findFirst({ where: { institutionId: A.id, kind: 'PRODUCTION' } });
    const cp = await registerCounterparty({ institutionId: A.id, environmentId: env.id, environmentKind: 'PRODUCTION' }, { label: 'Prod', address: CP_ADDR() });
    expect(cp.status).toBe('PENDING_APPROVAL');
    expect((await request(app).get('/api/settlement/counterparties/pending').set(ops).expect(200)).body.map((c: any) => c.id)).toContain(cp.id);
    await request(app).post(`/api/settlement/counterparties/${cp.id}/approve`).set(ops).send({ custodyWhitelisted: false }).expect(400);
    const ok = (await request(app).post(`/api/settlement/counterparties/${cp.id}/approve`).set(ops).send({ custodyWhitelisted: true, by: 'ops' }).expect(200)).body;
    expect(ok).toMatchObject({ status: 'ACTIVE', custodyWhitelisted: true });
    await expect(approveCounterparty(cp.id, 'x', { custodyWhitelisted: true })).rejects.toMatchObject({ code: 'NOT_PENDING' });
    await expect(svc.createTransfer({ institutionId: A.id, environmentId: env.id, environmentKind: 'PRODUCTION' }, { walletId: 'w', counterpartyId: cp.id, asset: 'USDC_SOL', amount: '1', idempotencyKey: key() })).rejects.toMatchObject({ code: 'OUTBOUND_DISABLED' });
  });
});
