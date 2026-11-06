import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { verifyFireblocksRequest, resetWebhookKeyCacheForTests } from '../../packages/providers/custody/fireblocks/fireblocks-webhook';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const url = 'https://sandbox-keys.fireblocks.io/.well-known/jwks.json';
const raw = Buffer.from('{ "type": "TRANSACTION_STATUS_UPDATED", "data": { "amount": "1.000001" } }');
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS512', use: 'sig' };
const detached = (body = raw, alg = 'RS512', kid = 'test-key') => {
  const header = Buffer.from(JSON.stringify({ alg, kid })).toString('base64url');
  const signature = crypto.sign('RSA-SHA512', Buffer.from(`${header}.${body.toString('base64url')}`), pair.privateKey).toString('base64url');
  return `${header}..${signature}`;
};
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; resetWebhookKeyCacheForTests(); });
afterEach(() => { process.env = saved; vi.restoreAllMocks(); });
describe('documented Fireblocks raw-byte verification', () => {
  it('verifies pinned RSA-SHA512 over the original bytes and rejects normalized or tampered JSON', async () => {
    process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY = publicKey;
    const sig = crypto.sign('RSA-SHA512', raw, pair.privateKey).toString('base64');
    expect(await verifyFireblocksRequest(raw, sig)).toBe(true);
    expect(await verifyFireblocksRequest(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), sig)).toBe(false);
    expect(await verifyFireblocksRequest(Buffer.from('{}'), sig)).toBe(false);
    expect(await verifyFireblocksRequest(raw, '')).toBe(false);
  });
  it('verifies detached RS512 JWS and caches operator-selected regional public keys', async () => {
    process.env.FIREBLOCKS_WEBHOOK_JWKS_URL = url;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] })));
    expect(await verifyFireblocksRequest(raw, '', detached())).toBe(true);
    expect(await verifyFireblocksRequest(raw, '', detached())).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(url);
    expect(await verifyFireblocksRequest(Buffer.from('{}'), '', detached())).toBe(false);
  });
  it('rejects algorithm substitution, unknown kid, malformed signature and body substitution', async () => {
    process.env.FIREBLOCKS_WEBHOOK_JWKS_URL = url;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ keys: [jwk] })));
    for (const jws of [detached(raw, 'HS256'), detached(raw, 'RS512', 'unknown'), 'invalid', detached(Buffer.from('{}'))]) {
      expect(await verifyFireblocksRequest(raw, '', jws)).toBe(false);
    }
  });
  it('fails closed on key outages and refuses arbitrary key endpoints', async () => {
    process.env.FIREBLOCKS_WEBHOOK_JWKS_URL = url;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await verifyFireblocksRequest(raw, '', detached())).toBe(false);
    process.env.FIREBLOCKS_WEBHOOK_JWKS_URL = 'https://attacker.example/keys';
    fetcher.mockClear();
    expect(await verifyFireblocksRequest(raw, '', detached())).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
