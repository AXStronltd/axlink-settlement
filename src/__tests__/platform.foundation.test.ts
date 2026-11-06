import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { loadConfig, ConfigError } from '../platform/config';
import { log, sink } from '../platform/logger';
import { hashKey, generateRawKey } from '../core/institutions/institution.service';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';

describe('config validation', () => {
  it('reports every problem at once and refuses to boot', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try { loadConfig({ DATABASE_URL: 'mysql://x', API_BASE_URL: 'not-a-url', PORT: 'abc' }); } catch (e) { expect((e as ConfigError).problems.length).toBeGreaterThanOrEqual(3); }
  });
  it('accepts a valid environment and lists unset provider credentials as sandboxed', () => {
    const r = loadConfig({ DATABASE_URL: 'postgresql://u@localhost:5432/db', API_BASE_URL: 'http://localhost:4000/api', FIREBLOCKS_API_KEY: 'your_key' });
    expect(r.config.PORT).toBe(4000); expect(r.sandboxProviders).toContain('FIREBLOCKS_API_KEY');
  });
  it('production foundation boots without an optional B2INPAY adapter, but configured adapters require a webhook secret', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://u@localhost/db', API_BASE_URL: 'https://api.example.test/api', OPS_API_KEY: 'k'.repeat(32), FIREBLOCKS_WEBHOOK_PUBLIC_KEY: 'test-public-key' };
    expect(() => loadConfig(env)).not.toThrow();
    for (const key of ['B2BINPAY_CLIENT_ID', 'B2BINPAY_CLIENT_SECRET']) {
      expect(() => loadConfig({ ...env, [key]: 'configured' })).toThrow(/B2BINPAY_CALLBACK_SECRET/);
    }
    expect(() => loadConfig({ ...env, B2BINPAY_CLIENT_ID: 'configured', B2BINPAY_CALLBACK_SECRET: 'callback-secret' })).not.toThrow();
  });
  it('production refuses simulator/demo flags and requires OPS_API_KEY', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u@h/db', API_BASE_URL: 'https://api.axlink.io/api', SIMULATOR_ENABLED: 'true' })).toThrow(/SIMULATOR_ENABLED|OPS_API_KEY/);
  });
});

describe('structured logging', () => {
  it('emits JSON lines and redacts credential-looking fields', () => {
    const lines: string[] = []; const orig = sink.write; sink.write = l => lines.push(l);
    try { log.info('hello', { apiKey: 'secret123', nested: { password: 'p', ok: 1 } }); } finally { sink.write = orig; }
    const j = JSON.parse(lines[0]); expect(j.msg).toBe('hello'); expect(j.apiKey).toBe('[REDACTED]'); expect(j.nested.password).toBe('[REDACTED]'); expect(j.nested.ok).toBe(1); expect(j.ts).toBeTruthy();
  });
});

describe('keys', () => {
  it('raw keys are CSPRNG-derived, prefixed by environment, and hash deterministically', () => {
    const a = generateRawKey('SANDBOX'), b = generateRawKey('SANDBOX'); expect(a).not.toBe(b); expect(a.startsWith('axlk_test_')).toBe(true); expect(generateRawKey('PRODUCTION').startsWith('axlk_live_')).toBe(true);
    expect(hashKey(a)).toBe(hashKey(a)); expect(hashKey(a)).not.toBe(hashKey(b)); expect(hashKey(a)).toHaveLength(64);
  });
});

const DB = process.env.DATABASE_URL;
const d = DB ? describe : describe.skip;
d('http foundation (requires DATABASE_URL)', () => {
  let app: import('express').Express;
  beforeAll(async () => { ({ app } = await import('../index')); });

  it('GET /api/health is public and carries a request id; X-Request-Id is honoured when safe', async () => {
    const r = await request(app).get('/api/health').expect(200); expect(r.body.service).toBe('axlink-settlement'); expect(r.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
    const r2 = await request(app).get('/api/health').set('X-Request-Id', 'client-req-0001').expect(200); expect(r2.headers['x-request-id']).toBe('client-req-0001');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
  it('GET /api/ready checks the database and migrations', async () => { const r = await request(app).get('/api/ready').expect(200); expect(r.body.checks.database.ok).toBe(true); expect(r.body.checks.migrations.ok).toBe(true); });
  it('GET /api/openapi.json serves the spec; unknown routes get the standard 404 envelope', async () => {
    const r = await request(app).get('/api/openapi.json').expect(200); expect(r.body.openapi).toBe('3.1.0'); expect(r.body.paths['/institutions']).toBeDefined();
    const n = await request(app).get('/api/no-such-route').expect(404); expect(n.body.error.code).toBe('NOT_FOUND'); expect(n.body.error.requestId).toBeTruthy();
  });
  it('institution lifecycle: ops creates, issues a sandbox key shown once, /me authenticates, revoke invalidates', async () => {
    const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` }; const slug = `test-inst-${Date.now()}`;
    await request(app).post('/api/institutions').send({ slug, legalName: 'Test Bank', country: 'KE', kind: 'BANK' }).expect(401); // no ops key
    const c = await request(app).post('/api/institutions').set(ops).send({ slug, legalName: 'Test Bank', country: 'KE', kind: 'BANK' }).expect(201);
    expect(c.body.environments.map((e: any) => `${e.kind}:${e.status}`).sort()).toEqual(['PRODUCTION:DISABLED', 'SANDBOX:ACTIVE']);
    const bad = await request(app).post('/api/institutions').set(ops).send({ slug: 'BAD SLUG', legalName: 'x', country: 'Kenya', kind: 'BANK' }).expect(400); expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const k = await request(app).post(`/api/institutions/${c.body.id}/credentials`).set(ops).send({ environment: 'SANDBOX', label: 'ci', scopes: ['settlement:read'] }).expect(201);
    expect(k.body.apiKey).toMatch(/^axlk_test_/); expect(k.body.credential.prefix).toBe(k.body.apiKey.slice(0, 12));
    await request(app).post(`/api/institutions/${c.body.id}/credentials`).set(ops).send({ environment: 'PRODUCTION', label: 'x' }).expect(409); // production disabled
    // institution is PENDING → key refused until ACTIVE
    await request(app).get('/api/institutions/me').set('Authorization', `Bearer ${k.body.apiKey}`).expect(401);
    const { prisma } = await import('../core/ledger.service'); await prisma.institution.update({ where: { id: c.body.id }, data: { status: 'ACTIVE' } });
    const me = await request(app).get('/api/institutions/me').set('Authorization', `Bearer ${k.body.apiKey}`).expect(200); expect(me.body.environment).toBe('SANDBOX'); expect(me.body.institution.slug).toBe(slug);
    await request(app).get('/api/institutions/me').set('Authorization', `Bearer ${k.body.apiKey}x`).expect(401);
    await request(app).post(`/api/institutions/${c.body.id}/credentials/${k.body.credential.id}/revoke`).set(ops).expect(200);
    await request(app).get('/api/institutions/me').set('Authorization', `Bearer ${k.body.apiKey}`).expect(401);
  });
  it('bank registration is no longer open: requires the operator key', async () => {
    await request(app).post('/api/network/banks/register').send({ name: 'x', networkId: 'AXLK-KE-999', vaultId: 'v' }).expect(401);
  });
});
