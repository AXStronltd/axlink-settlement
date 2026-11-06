/** Fireblocks documented signature verification over ORIGINAL bytes.
 * https://fireblocks.readme.io/reference/validating-webhooks
 * RS512 detached JWS uses an operator-selected, allowlisted regional JWKS endpoint.
 * Existing pinned static RSA-SHA512 signatures remain supported; no unsigned fallback.
 */
import crypto from 'crypto';
const URLS = new Set([
  'https://keys.fireblocks.io/.well-known/jwks.json',
  'https://eu-keys.fireblocks.io/.well-known/jwks.json',
  'https://eu2-keys.fireblocks.io/.well-known/jwks.json',
  'https://sandbox-keys.fireblocks.io/.well-known/jwks.json',
]);
type Key = crypto.JsonWebKeyInput['key'] & { kid?: string; alg?: string; use?: string };
const cache = new Map<string, { expires: number; keys: Key[] }>();
export function resetWebhookKeyCacheForTests(): void { cache.clear(); }
export function fireblocksVerificationConfigured(): boolean {
  const key = process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY ?? '';
  return (!!key && !/^your_/i.test(key)) || URLS.has(process.env.FIREBLOCKS_WEBHOOK_JWKS_URL ?? '');
}
export async function verifyFireblocksRequest(raw: Buffer, legacySignature: string, jws?: string): Promise<boolean> {
  try {
    if (!raw.length) return false;
    if (jws) {
      const url = process.env.FIREBLOCKS_WEBHOOK_JWKS_URL ?? '';
      if (!URLS.has(url)) return false;
      const parts = jws.split('.');
      if (parts.length !== 3 || parts[1] !== '' || !parts[0] || !parts[2]) return false;
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (header.alg !== 'RS512' || typeof header.kid !== 'string' || header.crit !== undefined || header.b64 === false) return false;
      let entry = cache.get(url);
      // Refresh on an unknown kid to permit key rotation; each response is bounded.
      if (!entry || entry.expires <= Date.now() || !entry.keys.some(k => k.kid === header.kid)) {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) return false;
        const body = await response.text();
        if (body.length > 100000) return false;
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed.keys) || parsed.keys.length > 100) return false;
        entry = { keys: parsed.keys, expires: Date.now() + 3600000 };
        cache.set(url, entry);
      }
      const matches = entry.keys.filter(k => k.kid === header.kid && k.kty === 'RSA' && k.alg === 'RS512' && k.use === 'sig');
      if (matches.length !== 1) return false;
      const publicKey = crypto.createPublicKey({ key: matches[0], format: 'jwk' });
      const signed = Buffer.from(`${parts[0]}.${raw.toString('base64url')}`, 'ascii');
      return crypto.verify('RSA-SHA512', signed, { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(parts[2], 'base64url'));
    }
    const key = process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY;
    if (!key || !legacySignature) return false;
    return crypto.verify('RSA-SHA512', raw, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(legacySignature, 'base64'));
  } catch { return false; }
}
