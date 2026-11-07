/**
 * Self-service SANDBOX signup: a bank signs itself up, gets a sandbox key once, and can use the API at
 * once — but never production. Requires DATABASE_URL.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

process.env.OPS_API_KEY ??= 'test-ops-key-0123456789abcdef';
process.env.API_BASE_URL ??= 'http://localhost:4000/api';
process.env.FIREBLOCKS_WORKSPACE_ID = 'test-workspace';
process.env.SIMULATOR_ENABLED = 'true';

const db = process.env.DATABASE_URL ? describe : describe.skip;
const ops = { Authorization: `Bearer ${process.env.OPS_API_KEY}` };

db('self-service sandbox signup', () => {
  let app: import('express').Express; let svc: typeof import('../../packages/core/institutions/onboarding.service');
  beforeAll(async () => { ({ app } = await import('../../apps/api/src/index')); svc = await import('../../packages/core/institutions/onboarding.service'); });
  beforeEach(() => svc.resetSignupRateLimitForTests());
  afterEach(() => { delete process.env.SANDBOX_SIGNUP; });
  const body = (over: Record<string, string> = {}) => ({ legalName: 'Test Bank of Somewhere', kind: 'BANK', country: 'KE', email: `ops-${randomUUID().slice(0, 8)}@bank.example`, contactName: 'Amina Test', ...over });
  const signup = (b: object, ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) =>
    request(app).post('/api/v1/onboarding/sandbox').set('X-Forwarded-For', ip).send(b);

  it('creates the institution, returns a sandbox key once, and the key works immediately — production stays disabled', async () => {
    expect((await request(app).get('/api/v1/onboarding/sandbox').expect(200)).body).toEqual({ open: true });
    const r = await signup(body()).expect(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ environment: 'SANDBOX', apiKey: expect.stringMatching(/^axlk_test_/), institution: { slug: expect.stringMatching(/^test-bank-of-somewhere-[0-9a-f]{6}$/) } });
    const auth = { Authorization: `Bearer ${r.body.apiKey}` };
    expect((await request(app).get('/api/v1/institutions/me').set(auth).expect(200)).body.environment).toBe('SANDBOX');
    const w = (await request(app).post('/api/v1/wallets').set(auth).send({ label: 'Treasury' }).expect(201)).body;
    expect(w.status).toBe('ACTIVE');
    const inst = (await request(app).get(`/api/institutions/${r.body.institution.id}`).set(ops).expect(200)).body;
    expect(inst.environments.find((e: any) => e.kind === 'PRODUCTION').status).toBe('DISABLED');
    await request(app).post(`/api/institutions/${r.body.institution.id}/credentials`).set(ops).send({ environment: 'PRODUCTION', label: 'x', scopes: ['wallets:read'] }).expect(409);
  });

  it('one sandbox account per email; invalid input is refused', async () => {
    const b = body();
    await signup(b).expect(201);
    expect((await signup({ ...b, legalName: 'Another Name' }).expect(409)).body.error.code).toBe('ALREADY_REGISTERED');
    await signup(body({ email: 'not-an-email' })).expect(400);
    await signup(body({ country: 'Kenya' })).expect(400);
    await signup(body({ kind: 'CENTRAL_BANK' })).expect(400);
  });

  it('rate-limited per client network', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < 5; i++) await signup(body(), ip).expect(201);
    expect((await signup(body(), ip).expect(429)).body.error.code).toBe('RATE_LIMITED');
    await signup(body(), '203.0.113.8').expect(201); // another network is unaffected
  });

  it('closed when switched off (and on any deployment whose custody is live)', async () => {
    process.env.SANDBOX_SIGNUP = 'off';
    expect((await request(app).get('/api/v1/onboarding/sandbox').expect(200)).body).toEqual({ open: false });
    expect((await signup(body()).expect(403)).body.error.code).toBe('SIGNUP_CLOSED');
  });

  it('a browser opening the site root lands on the website; API clients still get the JSON service document', async () => {
    await request(app).get('/').set('Accept', 'text/html').expect(302).expect('Location', '/portal');
    expect((await request(app).get('/').set('Accept', 'application/json').expect(200)).body.service).toBe('AxLink Settlement API');
  });
});
