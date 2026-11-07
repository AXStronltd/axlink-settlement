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
  const body = (over: Record<string, string> = {}) => ({ legalName: 'Test Bank of Somewhere', kind: 'BANK', country: 'KE', email: `ops-${randomUUID().slice(0, 8)}@bank.example`, contactName: 'Amina Test', password: 'correct-horse-42-battery', ...over });
  const cookieOf = (r: request.Response) => String((r.headers['set-cookie'] as unknown as string[] | undefined)?.[0] ?? '').split(';')[0];
  const P = { 'X-AxLink-Portal': '1' };
  const signup = (b: object, ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) =>
    request(app).post('/api/v1/onboarding/sandbox').set('X-Forwarded-For', ip).set('X-Forwarded-Proto', 'https').send(b); // as behind Render's TLS proxy

  it('creates the institution and its first user, signs them in by cookie (no key), and production stays disabled', async () => {
    expect((await request(app).get('/api/v1/onboarding/sandbox').expect(200)).body).toEqual({ open: true });
    const r = await signup(body()).expect(201);
    expect(r.body.apiKey).toBeUndefined();
    expect(r.body).toMatchObject({ environment: 'SANDBOX', user: { role: 'ADMIN' }, institution: { slug: expect.stringMatching(/^test-bank-of-somewhere-[0-9a-f]{6}$/) } });
    const setCookie = String((r.headers['set-cookie'] as unknown as string[])[0]);
    expect(setCookie).toMatch(/^axs=[A-Za-z0-9_-]{40,};/); expect(setCookie).toMatch(/HttpOnly/); expect(setCookie).toMatch(/SameSite=Strict/); expect(setCookie).toMatch(/Secure/);
    const c = { Cookie: cookieOf(r) };
    expect((await request(app).get('/api/v1/institutions/me').set(c).expect(200)).body.environment).toBe('SANDBOX');
    expect((await request(app).get('/api/v1/auth/session').set(c).expect(200)).body.user.email).toMatch(/@bank\.example$/);
    const w = (await request(app).post('/api/v1/wallets').set(c).set(P).send({ label: 'Treasury' }).expect(201)).body;
    expect(w.status).toBe('ACTIVE');
    const inst = (await request(app).get(`/api/institutions/${r.body.institution.id}`).set(ops).expect(200)).body;
    expect(inst.environments.find((e: any) => e.kind === 'PRODUCTION').status).toBe('DISABLED');
  });

  it('a cookie-authenticated write without the portal header is refused (CSRF)', async () => {
    const c = { Cookie: cookieOf(await signup(body()).expect(201)) };
    await request(app).post('/api/v1/wallets').set(c).send({ label: 'X' }).expect(403);
    await request(app).get('/api/v1/wallets').set(c).expect(200); // reads are fine
  });

  it('sign in / sign out: generic failures, lockout after 5, revoked session is dead', async () => {
    const b = body(); await signup(b).expect(201);
    await request(app).post('/api/v1/auth/login').send({ email: b.email, password: 'wrong-password-1' }).expect(401);
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: `nobody-${randomUUID()}@x.example`, password: 'whatever-12345' }).expect(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS'); // same answer as a wrong password
    const ok = await request(app).post('/api/v1/auth/login').send({ email: b.email.toUpperCase(), password: b.password }).expect(200);
    const c = { Cookie: cookieOf(ok) };
    await request(app).get('/api/v1/institutions/me').set(c).expect(200);
    await request(app).post('/api/v1/auth/logout').set(c).expect(204);
    await request(app).get('/api/v1/institutions/me').set(c).expect(401);
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').send({ email: b.email, password: `bad-${i}-password` }).expect(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: b.email, password: b.password }).expect(429)).body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('only a signed-in person creates API keys; the key works for servers; a key cannot create keys', async () => {
    const c = { Cookie: cookieOf(await signup(body()).expect(201)) };
    const k = (await request(app).post('/api/v1/portal/credentials').set(c).set(P).send({ label: 'Core banking' }).expect(201)).body;
    expect(k.apiKey).toMatch(/^axlk_test_/);
    const bearer = { Authorization: `Bearer ${k.apiKey}` };
    expect((await request(app).get('/api/v1/institutions/me').set(bearer).expect(200)).body.environment).toBe('SANDBOX');
    await request(app).post('/api/v1/portal/credentials').set(bearer).send({ label: 'x' }).expect(403);
    const list = (await request(app).get('/api/v1/portal/credentials').set(c).expect(200)).body;
    expect(list.map((x: any) => x.id)).toContain(k.id); expect(JSON.stringify(list)).not.toContain(k.apiKey);
    await request(app).post(`/api/v1/portal/credentials/${k.id}/revoke`).set(c).set(P).expect(200);
    await request(app).get('/api/v1/institutions/me').set(bearer).expect(401);
  });

  it('weak passwords are refused', async () => {
    await signup(body({ password: 'short1' })).expect(400);
    await signup(body({ password: 'onlyletterspassword' })).expect(400);
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
