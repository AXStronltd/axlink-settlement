/**
 * Leg A verification (2026-11-06) — evidence for the Codex review of commit 6d26e5d.
 * These tests assert the CURRENT behaviour of the repository. Where a required behaviour is
 * missing, the test is written to document the gap (it.fails / explicit expectation of the gap),
 * so the suite is green and the report can cite each gap by name.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { SOLANA_MINTS, SETTLEMENT_ASSET } from '../../packages/providers/blockchain/solana/solana';
import { assertBalanced } from '../../packages/core/ledger/journal.service';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
const DB = process.env.DATABASE_URL; const d = DB ? describe : describe.skip;

// Authoritative Solana mainnet mints (Circle USDC, Tether USDT), checked against the repo table.
const AUTHORITATIVE = { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' };

describe('3/4 · asset identity: network + token contract, not ticker alone', () => {
  it('backend keys both assets by SPL mint with authoritative mainnet addresses and 6 decimals', () => {
    expect(SOLANA_MINTS.USDC.mint).toBe(AUTHORITATIVE.USDC); expect(SOLANA_MINTS.USDT.mint).toBe(AUTHORITATIVE.USDT);
    expect(SOLANA_MINTS.USDC.decimals).toBe(6); expect(SOLANA_MINTS.USDT.decimals).toBe(6);
    expect(SOLANA_MINTS.USDC.mint).not.toBe(SOLANA_MINTS.USDT.mint);
  });
  it('GAP: the backend settles in ONE configured asset at a time (SETTLEMENT_ASSET), not both per vault', () => {
    expect(['USDC', 'USDT']).toContain(SETTLEMENT_ASSET); // single global value — per-institution/per-vault asset selection does not exist yet
  });
  it('GAP: the mint table has no chain/network dimension (Solana is implicit); an unsupported network cannot be expressed, only an unknown asset', () => {
    expect(Object.keys(SOLANA_MINTS)).toEqual(['USDT', 'USDC']);
    expect((SOLANA_MINTS.USDC as { chain?: string }).chain).toBeUndefined();
  });
  it('ledger account codes separate assets by ticker (custody) and by mint (on-chain)', async () => {
    const { AccountCode } = await import('../../packages/core/ledger/accounts');
    expect(AccountCode.custody('v1', 'usdc')).toBe('CUSTODY:v1:USDC'); expect(AccountCode.custody('v1', 'usdt')).toBe('CUSTODY:v1:USDT');
    expect(AccountCode.onchain(AUTHORITATIVE.USDC)).not.toBe(AccountCode.onchain(AUTHORITATIVE.USDT));
  });
});

describe('8 · arithmetic: journal is Decimal and balances per currency; legacy paths still use Number', () => {
  it('journal refuses a posting that mixes USDC and USDT as if they were one currency', () => {
    expect(() => assertBalanced('k', [{ account: 'CUSTODY:v1:USDC', amount: '100', currency: 'USDC' }, { account: 'CUSTODY:v1:USDT', amount: '-100', currency: 'USDT' }])).toThrow();
    expect(() => assertBalanced('k', [{ account: 'CUSTODY:v1:USDC', amount: '100', currency: 'USDC' }, { account: 'TREASURY:USDC', amount: '-100', currency: 'USDC' }])).not.toThrow();
  });
  it('journal amounts are Prisma.Decimal (exact), e.g. 0.1 + 0.2 === 0.3', () => {
    expect(new Prisma.Decimal('0.1').plus('0.2').equals('0.3')).toBe(true);
  });
  it('F5 fixed: ledger.service no longer converts Decimal balances to Number on posting paths', async () => {
    const fs = await import('fs'); const src = fs.readFileSync('packages/core/ledger/ledger.service.ts', 'utf8');
    expect(/Number\(account\.balance\)/.test(src)).toBe(false); // was a documented gap; closed by the remediation branch
  });
});

describe('10 · providers behind interfaces', () => {
  const walk = async (dir: string): Promise<string[]> => {
    const fs = await import('fs'); const path = await import('path'); const out: string[] = [];
    for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) out.push(...await walk(p)); else if (p.endsWith('.ts')) out.push(p); }
    return out;
  };
  const LIVE = /providers\/(custody\/fireblocks|liquidity\/b2binpay)\//;
  it('the settlement engine (orchestration, proof, reconciliation) reaches converter, custody and chain only through the ports seam', async () => {
    const fs = await import('fs'); const offenders: string[] = [];
    for (const f of await walk('packages/settlement/orchestration')) if (LIVE.test(fs.readFileSync(f, 'utf8'))) offenders.push(f);
    for (const f of await walk('packages/settlement/proof')) if (LIVE.test(fs.readFileSync(f, 'utf8'))) offenders.push(f);
    for (const f of await walk('packages/settlement/reconciliation')) if (LIVE.test(fs.readFileSync(f, 'utf8'))) offenders.push(f);
    expect(offenders).toEqual([]);
  });
  it('GAP: some legacy settlement services still import live providers directly (not yet mapped onto packages/providers/ports)', async () => {
    const fs = await import('fs'); const hits: string[] = [];
    for (const f of [...await walk('packages/settlement'), ...await walk('packages/core')]) if (LIVE.test(fs.readFileSync(f, 'utf8'))) hits.push(f);
    expect(hits.length).toBeGreaterThan(0); // documented gap for the port-mapping milestone
    console.log('direct live-provider imports:', hits.join(', '));
  });
  it('the five port interfaces exist and the current providers are mapped to roles', async () => {
    const m = await import('../../packages/providers/ports'); expect(m.PROVIDER_ROLES.fireblocks).toEqual(['custody', 'blockchainExecution']); expect(m.PROVIDER_ROLES.b2binpay).toEqual(['liquidity']);
  });
});

d('6/7/11 · deposits, tenancy and duplicate events against the live app (requires DATABASE_URL)', () => {
  let app: import('express').Express; let prisma: any;
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); ({ prisma } = await import('../../packages/core/ledger/ledger.service')); });

  it('7 · institution credentials are scoped: a key of institution A cannot read institution B; legacy customer routes now require an actor (F4 fixed)', async () => {
    const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` }; const t = Date.now();
    const a = await request(app).post('/api/institutions').set(ops).send({ slug: `inst-a-${t}`, legalName: 'Institution A', country: 'KE', kind: 'BANK' }).expect(201);
    const b = await request(app).post('/api/institutions').set(ops).send({ slug: `inst-b-${t}`, legalName: 'Institution B', country: 'SO', kind: 'BANK' }).expect(201);
    await prisma.institution.updateMany({ where: { id: { in: [a.body.id, b.body.id] } }, data: { status: 'ACTIVE' } });
    const ka = await request(app).post(`/api/institutions/${a.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'k' }).expect(201);
    const me = await request(app).get('/api/institutions/me').set('Authorization', `Bearer ${ka.body.apiKey}`).expect(200);
    expect(me.body.institution.id).toBe(a.body.id); expect(me.body.institution.id).not.toBe(b.body.id);
    await request(app).get(`/api/institutions/${b.body.id}`).set('Authorization', `Bearer ${ka.body.apiKey}`).expect(401); // institution keys never reach ops routes
    // legacy customer API: was open to anyone (S2); now 401 without an operator or institution key.
    await request(app).post('/api/users').send({ name: 'Tenant Test', email: `t${t}@x.io`, currency: 'USD' }).expect(401);
    await request(app).get('/api/users/anything').expect(401);
  });

  it('6/11 · Fireblocks deposit webhook (post-remediation): USDC and USDT both credit; replay credits once; unsigned events are refused — full coverage in remediation.step1.test.ts', async () => {
    // Unsigned: refused before any state change (F2). The asset/dedupe behaviour is covered by remediation.step1.test.ts.
    const r = await request(app).post('/api/webhooks/fireblocks').send({ type: 'TRANSACTION_STATUS_UPDATED', data: { id: 'x', status: 'COMPLETED', assetId: 'USDT_SOL' } });
    expect([401, 503]).toContain(r.status);
  });

  it('11 · proof service rejects an unknown asset key (incorrect mint cannot be selected by name)', async () => {
    const { proveSettlement } = await import('../../packages/settlement/proof/proof.service');
    await expect(proveSettlement({ entityType: 'SettlementLeg', entityId: 'x', asset: 'USDX' as any, signature: 'sig' } as any)).rejects.toThrow(/Unknown settlement asset/);
  });
});
