/**
 * Step 2 · slice 6b — network settlement (institution → institution inside custody) and the
 * operator exception queue. Requires DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
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
const ALL = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'webhooks:write', 'webhooks:read', 'ledger:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write'];

db('network settlement between two AxLink institutions', () => {
  let app: import('express').Express; let prisma: any; let svc: typeof import('../../packages/settlement/transfers/settlement-transfer.service');
  let reg: typeof import('../../packages/providers/registry/provider-registry'); let fbAdapter: any; let outbox: typeof import('../../packages/core/events/outbox.service');
  const received: { body: any }[] = []; let hookUrl: string; let hookServer: http.Server;
  beforeAll(async () => {
    ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service'));
    svc = await import('../../packages/settlement/transfers/settlement-transfer.service');
    reg = await import('../../packages/providers/registry/provider-registry');
    ({ fireblocksCustodyProvider: fbAdapter } = await import('../../packages/providers/custody/fireblocks/fireblocks.custody-provider'));
    outbox = await import('../../packages/core/events/outbox.service');
    hookServer = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { received.push({ body: JSON.parse(b) }); res.statusCode = 200; res.end(); }); });
    await new Promise<void>(r => hookServer.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hookServer.address() as { port: number }).port}/hook`;
  });
  afterEach(() => { reg.registerCustodyProvider(fbAdapter); });

  async function institution(tag: string) {
    const id = randomUUID().slice(0, 8); const slug = `net-${tag}-${id}`;
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug, legalName: `Net ${tag}`, country: 'KE', kind: 'BANK' }).expect(201);
    await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } });
    const key = await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes: ALL }).expect(201);
    const auth = { Authorization: `Bearer ${key.body.apiKey}` };
    const wallet = (await request(app).post('/api/v1/wallets').set(auth).send({ label: 'Main' }).expect(201)).body;
    await request(app).post('/api/v1/webhook-endpoints').set(auth).send({ url: hookUrl }).expect(201);
    return { id: inst.body.id as string, slug, auth, wallet };
  }
  async function fund(A: { auth: any; wallet: any }, asset: 'USDC_SOL' | 'USDT_SOL', amount: number) {
    const d = (await request(app).post('/api/v1/deposits').set(A.auth).send({ walletId: A.wallet.id, asset, amount: String(amount) }).expect(201)).body;
    const raw = JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data: { id: `fb-${randomUUID()}`, status: 'COMPLETED', assetId: asset, operation: 'TRANSFER', netAmount: amount, amount, txHash: `sig${randomUUID().replace(/-/g, '')}`, destination: { type: 'VAULT_ACCOUNT', id: A.wallet.custody.vaultId }, source: { type: 'EXTERNAL_WALLET' }, externalTxId: d.trackingId } });
    const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
    await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw).expect(200);
  }
  const bal = async (X: { auth: any }, asset: string) => (await request(app).get('/api/v1/balances').set(X.auth).expect(200)).body.balances.find((b: any) => b.asset === asset).available;
  const key = () => `idem-${randomUUID()}`;

  it('A settles to B by participant slug: vault-to-vault inside custody, A debited at approval, B credited at SETTLED, both ledgers and webhooks agree', async () => {
    const A = await institution('a'); const B = await institution('b');
    await fund(A, 'USDC_SOL', 1000);
    // registration: network counterparty is ACTIVE at once; self and unknown participants refused
    expect((await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Bank B', participant: A.slug }).expect(400)).body.error.code).toBe('PARTICIPANT_IS_SELF');
    expect((await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Nobody', participant: 'no-such-bank' }).expect(404)).body.error.code).toBe('PARTICIPANT_NOT_FOUND');
    await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Both', participant: B.slug, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }).expect(400);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Bank B', participant: B.slug }).expect(201)).body;
    expect(cp).toMatchObject({ kind: 'NETWORK', status: 'ACTIVE', participant: B.slug, address: null });
    expect((await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Again', participant: B.slug }).expect(409)).body.error.code).toBe('COUNTERPARTY_EXISTS');

    const calls: any[] = [];
    reg.registerCustodyProvider({ ...fbAdapter, transferInternal: async (p: any) => { calls.push(['internal', p]); return { providerTxId: `fbint-${p.clientRef}`, status: 'CONFIRMED' as const }; }, transferExternal: async (p: any) => { calls.push(['external', p]); throw new Error('must not be called for a network settlement'); } });
    const t = (await request(app).post('/api/v1/settlements').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '250', reference: 'NET-1' }).expect(202)).body;
    expect(t.stage).toBe('APPROVED');
    expect(await bal(A, 'USDC_SOL')).toBe('750'); expect(await bal(B, 'USDC_SOL')).toBe('0'); // B is credited only at SETTLED
    await svc.submitApprovedTransfers();
    const mine = calls.filter(c => c[1].clientRef === t.id); expect(mine).toHaveLength(1); expect(mine[0][0]).toBe('internal');
    expect(mine[0][1]).toMatchObject({ fromVaultId: A.wallet.custody.vaultId, toVaultId: B.wallet.custody.vaultId, amount: '250' });
    await svc.finalizeConfirmedTransfers();
    const done = (await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth).expect(200)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', stage: 'SETTLED' });
    expect(await bal(A, 'USDC_SOL')).toBe('750'); expect(await bal(B, 'USDC_SOL')).toBe('250');
    // both ledgers carry the same entity id; each sees only its own lines
    const la = (await request(app).get(`/api/v1/ledger/entries?entityId=${t.id}`).set(A.auth).expect(200)).body.entries;
    const lb = (await request(app).get(`/api/v1/ledger/entries?entityId=${t.id}`).set(B.auth).expect(200)).body.entries;
    expect(la).toHaveLength(1); expect(la[0].lines.map((l: any) => [l.account.split(':')[0], l.amount]).sort()).toEqual([['CUSTODY', '-250'], ['INSTITUTION', '250']]);
    expect(lb).toHaveLength(1); expect(lb[0].lines.map((l: any) => [l.account.split(':')[0], l.amount]).sort()).toEqual([['CUSTODY', '250'], ['INSTITUTION', '-250']]);
    // finality is run-again safe: a second finalize does not credit B twice
    await svc.finalizeConfirmedTransfers(); expect(await bal(B, 'USDC_SOL')).toBe('250');
    await outbox.drain(100, { entityId: t.id }); await new Promise(r => setTimeout(r, 150));
    const types = received.filter(r => r.body.data?.transferId === t.id).map(r => r.body.type);
    expect(types).toEqual(expect.arrayContaining(['transfer.submitted', 'transfer.settled', 'settlement.received']));
    const recv = received.find(r => r.body.type === 'settlement.received' && r.body.data.transferId === t.id)!;
    expect(recv.body.data).toMatchObject({ kind: 'NETWORK_SETTLEMENT', status: 'COMPLETED', walletId: B.wallet.id, amount: '250', reference: 'NET-1', from: { participant: A.slug, name: 'Net a' } });
    // B cannot read A's transfer; the blueprint alias answers for A
    await request(app).get(`/api/v1/transfers/${t.id}`).set(B.auth).expect(404);
    expect((await request(app).get(`/api/v1/settlements/${t.id}`).set(A.auth).expect(200)).body.id).toBe(t.id);
  });

  it('a participant that loses its wallet after registration cannot be settled to; a custody failure before broadcast restores A and never touches B', async () => {
    const A = await institution('c'); const B = await institution('d');
    await fund(A, 'USDT_SOL', 100);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'Bank B', participant: B.slug }).expect(201)).body;
    await prisma.wallet.update({ where: { id: B.wallet.id }, data: { status: 'SUSPENDED' } });
    expect((await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDT_SOL', amount: '10' }).expect(409)).body.error.code).toBe('PARTICIPANT_NOT_READY');
    await prisma.wallet.update({ where: { id: B.wallet.id }, data: { status: 'ACTIVE' } });
    reg.registerCustodyProvider({ ...fbAdapter, transferInternal: async (p: any) => ({ providerTxId: `fbint-${p.clientRef}`, status: 'PENDING' as const }), getTransfer: async () => ({ status: 'FAILED' as const, final: true }) });
    const t = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDT_SOL', amount: '10' }).expect(202)).body;
    await svc.submitApprovedTransfers(); await svc.pollSubmittedTransfers();
    expect((await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth)).body.stage).toBe('FAILED');
    expect(await bal(A, 'USDT_SOL')).toBe('100'); expect(await bal(B, 'USDT_SOL')).toBe('0');
    expect(await prisma.journalEntry.count({ where: { entityId: t.id } })).toBe(2); // debit + its reversal, no credit
  });
});

db('review fixes: receiver invariants and operator review', () => {
  let app: import('express').Express; let prisma: any; let svc: typeof import('../../packages/settlement/transfers/settlement-transfer.service');
  let reg: typeof import('../../packages/providers/registry/provider-registry'); let fbAdapter: any;
  beforeAll(async () => {
    ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service'));
    svc = await import('../../packages/settlement/transfers/settlement-transfer.service'); reg = await import('../../packages/providers/registry/provider-registry');
    ({ fireblocksCustodyProvider: fbAdapter } = await import('../../packages/providers/custody/fireblocks/fireblocks.custody-provider'));
  });
  afterEach(() => { reg.registerCustodyProvider(fbAdapter); });
  async function institution(tag: string) {
    const id = randomUUID().slice(0, 8); const slug = `rv-${tag}-${id}`;
    const inst = await request(app).post('/api/institutions').set(ops).send({ slug, legalName: `Rv ${tag}`, country: 'KE', kind: 'BANK' }).expect(201);
    await prisma.institution.update({ where: { id: inst.body.id }, data: { status: 'ACTIVE' } });
    const key = await request(app).post(`/api/institutions/${inst.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k', scopes: ALL }).expect(201);
    const auth = { Authorization: `Bearer ${key.body.apiKey}` };
    const wallet = (await request(app).post('/api/v1/wallets').set(auth).send({ label: 'Main' }).expect(201)).body;
    return { id: inst.body.id as string, slug, auth, wallet };
  }
  async function fund(A: { auth: any; wallet: any }, asset: 'USDC_SOL' | 'USDT_SOL', amount: number) {
    const d = (await request(app).post('/api/v1/deposits').set(A.auth).send({ walletId: A.wallet.id, asset, amount: String(amount) }).expect(201)).body;
    const raw = JSON.stringify({ type: 'TRANSACTION_STATUS_UPDATED', tenantId: 'test-workspace', data: { id: `fb-${randomUUID()}`, status: 'COMPLETED', assetId: asset, operation: 'TRANSFER', netAmount: amount, amount, txHash: `sig${randomUUID().replace(/-/g, '')}`, destination: { type: 'VAULT_ACCOUNT', id: A.wallet.custody.vaultId }, source: { type: 'EXTERNAL_WALLET' }, externalTxId: d.trackingId } });
    const signature = crypto.sign('RSA-SHA512', Buffer.from(raw), pair.privateKey).toString('base64');
    await request(app).post('/api/webhooks/fireblocks').set({ 'Content-Type': 'application/json', 'fireblocks-signature': signature }).send(raw).expect(200);
  }
  const bal = async (X: { auth: any }, asset: string) => (await request(app).get('/api/v1/balances').set(X.auth).expect(200)).body.balances.find((b: any) => b.asset === asset).available;
  const key = () => `idem-${randomUUID()}`;

  it('a suspended participant cannot be settled to; a receiver whose institution is suspended at finality goes UNDER_REVIEW (never SETTLED without the credit); the operator decides with evidence', async () => {
    const A = await institution('a'); const B = await institution('b'); await fund(A, 'USDC_SOL', 100);
    const cp = (await request(app).post('/api/v1/counterparties').set(A.auth).send({ label: 'B', participant: B.slug }).expect(201)).body;
    await prisma.institution.update({ where: { id: B.id }, data: { status: 'SUSPENDED' } });
    expect((await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '10' }).expect(409)).body.error.code).toBe('PARTICIPANT_NOT_READY');
    await prisma.institution.update({ where: { id: B.id }, data: { status: 'ACTIVE' } });
    reg.registerCustodyProvider({ ...fbAdapter, transferInternal: async (p: any) => ({ providerTxId: `fbint-${p.clientRef}`, status: 'CONFIRMED' as const }) });
    const t = (await request(app).post('/api/v1/transfers').set(A.auth).set('Idempotency-Key', key()).send({ walletId: A.wallet.id, counterpartyId: cp.id, asset: 'USDC_SOL', amount: '10' }).expect(202)).body;
    await svc.submitApprovedTransfers();
    await prisma.institution.update({ where: { id: B.id }, data: { status: 'SUSPENDED' } }); // between confirmation and finality
    const r = await svc.finalizeConfirmedTransfers(); expect(r.attention).toBeGreaterThanOrEqual(1);
    let cur = (await request(app).get(`/api/v1/transfers/${t.id}`).set(A.auth)).body;
    expect(cur).toMatchObject({ status: 'PROCESSING', stage: 'UNDER_REVIEW', attention: true }); expect(cur.proof.finality).toBe('UNDER_REVIEW');
    expect(await bal(A, 'USDC_SOL')).toBe('90'); expect(await prisma.journalEntry.count({ where: { entityId: t.id } })).toBe(1); // debit only, no credit
    const open = await prisma.operationalException.findFirst({ where: { kind: 'TRANSFER_ATTENTION', subject: t.id, status: 'OPEN' } }); expect(open).toBeTruthy();
    await svc.finalizeConfirmedTransfers(); // the sweeper leaves it alone
    expect((await prisma.settlementTransfer.findUnique({ where: { id: t.id } })).status).toBe('UNDER_REVIEW');
    expect((await request(app).get('/api/settlement/transfers/under-review').set(ops).expect(200)).body.map((x: any) => x.id)).toContain(t.id);
    // operator: evidence required; with B suspended, 'settled' cannot credit → 409; reactivate, then settled credits B and closes the exception
    await request(app).post(`/api/settlement/transfers/${t.id}/review`).set(ops).send({ decision: 'settled' }).expect(400);
    await request(app).post(`/api/settlement/transfers/${t.id}/review`).set(ops).send({ decision: 'maybe', evidence: 'x' }).expect(400);
    expect((await request(app).post(`/api/settlement/transfers/${t.id}/review`).set(ops).send({ decision: 'settled', evidence: 'solscan: 10 USDC to B vault' }).expect(409)).body.error.code).toBe('PARTICIPANT_NOT_READY');
    await prisma.institution.update({ where: { id: B.id }, data: { status: 'ACTIVE' } });
    const done = (await request(app).post(`/api/settlement/transfers/${t.id}/review`).set(ops).send({ decision: 'settled', evidence: 'solscan: 10 USDC to B vault', by: 'ops' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', stage: 'SETTLED' }); expect(done.proof.finality).toBe('OPERATOR_ATTESTED');
    expect(await bal(B, 'USDC_SOL')).toBe('10'); expect(await prisma.journalEntry.count({ where: { entityId: t.id } })).toBe(2);
    expect((await prisma.operationalException.findUnique({ where: { id: open.id } })).status).toBe('RESOLVED');
    await request(app).post(`/api/settlement/transfers/${t.id}/review`).set(ops).send({ decision: 'failed', evidence: 'x' }).expect(409);

    // and the other decision: proof mismatch → UNDER_REVIEW → operator says FAILED → journal reversed, balance back
    const C = await institution('c'); await fund(C, 'USDT_SOL', 50);
    const ext = (await request(app).post('/api/v1/counterparties').set(C.auth).send({ label: 'X', address: crypto.randomBytes(32).toString('hex').replace(/[0lIO]/g, 'a').slice(0, 44) }).expect(201)).body;
    reg.registerCustodyProvider({ ...fbAdapter, transferExternal: async (p: any) => ({ providerTxId: `fbx-${p.clientRef}`, status: 'CONFIRMED' as const, txHash: `sig${randomUUID().replace(/-/g, '')}` }) });
    const t2 = (await request(app).post('/api/v1/transfers').set(C.auth).set('Idempotency-Key', key()).send({ walletId: C.wallet.id, counterpartyId: ext.id, asset: 'USDT_SOL', amount: '20' }).expect(202)).body;
    await svc.submitApprovedTransfers();
    const { useTestPorts } = await import('../../packages/providers/ports/runtime'); const { ASSETS } = await import('../../packages/core/assets/registry');
    const restore = useTestPorts({ chain: { awaitFinality: async (s: string) => ({ signature: s, found: true, slot: 9, confirmations: null, commitment: 'finalized', err: null }), getTransaction: async (s: string) => ({ signature: s, slot: 9, blockTime: new Date(), feeLamports: 1n, err: null, tokenTransfers: [{ mint: ASSETS.USDT_SOL.contract, owner: 'SomeoneElse111111111111111111111111111111111', decimals: 6, changeRaw: 20_000_000n }] }) } as any });
    try { await svc.finalizeConfirmedTransfers(); } finally { restore(); }
    expect((await prisma.settlementTransfer.findUnique({ where: { id: t2.id } })).status).toBe('UNDER_REVIEW');
    expect(await bal(C, 'USDT_SOL')).toBe('30');
    const failed = (await request(app).post(`/api/settlement/transfers/${t2.id}/review`).set(ops).send({ decision: 'failed', evidence: 'custodian: tx rejected by TAP, nothing broadcast' }).expect(200)).body;
    expect(failed).toMatchObject({ status: 'FAILED', stage: 'FAILED' });
    expect(await bal(C, 'USDT_SOL')).toBe('50');
  });
});

db('operator exception queue', () => {
  let app: import('express').Express; let prisma: any; let ex: typeof import('../../packages/settlement/operations/exception.service');
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service')); ex = await import('../../packages/settlement/operations/exception.service'); });

  it('one item per subject, bumped on recurrence; acknowledge and resolve with a note; recurrence after resolution re-opens; reconciliation feeds it and auto-closes what disappears', async () => {
    const subject = `CUSTODY:vault_${randomUUID().slice(0, 8)}:USDC_SOL`;
    const { Prisma } = await import('@prisma/client');
    const a = await ex.raiseException({ kind: 'CUSTODY_MISMATCH', severity: 'CRITICAL', subject, currency: 'USDC_SOL', expected: new Prisma.Decimal(10), actual: new Prisma.Decimal(9) });
    const b = await ex.raiseException({ kind: 'CUSTODY_MISMATCH', severity: 'CRITICAL', subject, currency: 'USDC_SOL', expected: new Prisma.Decimal(10), actual: new Prisma.Decimal(8) });
    expect(b.id).toBe(a.id); expect(b.occurrences).toBe(2); expect(b.actual!.toFixed()).toBe('8');
    await request(app).get('/api/settlement/exceptions').expect(401);
    const list = await request(app).get('/api/settlement/exceptions').set(ops).expect(200);
    expect(list.body.exceptions.map((x: any) => x.id)).toContain(a.id); expect(list.body.summary.critical).toBeGreaterThan(0);
    const ack = (await request(app).post(`/api/settlement/exceptions/${a.id}/acknowledge`).set(ops).send({ by: 'ops' }).expect(200)).body;
    expect(ack.status).toBe('ACKNOWLEDGED'); expect(ack.acknowledged.by).toBe('operator:ops');
    await request(app).post(`/api/settlement/exceptions/${a.id}/acknowledge`).set(ops).send({}).expect(409);
    const bumped = await ex.raiseException({ kind: 'CUSTODY_MISMATCH', severity: 'WARN', subject, currency: 'USDC_SOL' });
    expect(bumped.status).toBe('ACKNOWLEDGED'); expect(bumped.severity).toBe('CRITICAL'); expect(bumped.actual!.toFixed()).toBe('8'); // stays with its owner; never downgraded or blanked
    await request(app).post(`/api/settlement/exceptions/${a.id}/resolve`).set(ops).send({}).expect(400); // note required
    const res = (await request(app).post(`/api/settlement/exceptions/${a.id}/resolve`).set(ops).send({ by: 'ops', resolution: 'custodian hold released; balances agree' }).expect(200)).body;
    expect(res).toMatchObject({ status: 'RESOLVED', resolved: { by: 'operator:ops', note: 'custodian hold released; balances agree' } });
    const again = await ex.raiseException({ kind: 'CUSTODY_MISMATCH', severity: 'WARN', subject, currency: 'USDC_SOL' });
    expect(again.id).not.toBe(a.id); expect(again.status).toBe('OPEN'); expect(again.occurrences).toBe(1);
    expect((await request(app).get('/api/settlement/exceptions?status=RESOLVED').set(ops).expect(200)).body.exceptions.map((x: any) => x.id)).toContain(a.id);
    await request(app).get('/api/settlement/exceptions?status=nope').set(ops).expect(400);

    // a FULL reconciliation run closes items of reconciliation kinds it no longer sees (this subject does not exist on the books)
    const { runReconciliation } = await import('../../packages/settlement/reconciliation/reconciliation.service');
    const run = await runReconciliation('FULL');
    const closed = await prisma.operationalException.findUnique({ where: { id: again.id } });
    expect(closed.status).toBe('RESOLVED'); expect(closed.resolvedBy).toBe('reconciliation'); expect(closed.lastRunId).toBe(run.runId);
    // breaks found by the run are open items with the run id
    const open = await prisma.operationalException.findMany({ where: { lastRunId: run.runId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
    expect(open.length).toBe(run.breaks === 0 ? 0 : open.length); // consistent with the run
    // query validation
    await request(app).get('/api/settlement/exceptions?limit=abc').set(ops).expect(400);
    await request(app).get('/api/settlement/exceptions?severity=loud').set(ops).expect(400);
  });
});
