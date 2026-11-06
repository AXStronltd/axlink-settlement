/**
 * Encryption at rest for secrets we must be able to read back (webhook signing secrets).
 * AES-256-GCM under WEBHOOK_ENCRYPTION_KEY (32 bytes, base64 or hex). Outside production a fixed
 * development key is used so sandbox setups work; production refuses to start without a real key
 * (see config.ts). Ciphertext format: `enc:v1:<iv b64>:<tag b64>:<data b64>`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const DEV_KEY = Buffer.from('axlink-dev-webhook-encryption-key-32b!!').subarray(0, 32);

function key(): Buffer {
  const raw = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!raw) {
    // The committed development key is acceptable only where no real institution can exist.
    const env = process.env.NODE_ENV ?? 'development';
    if (env !== 'development' && env !== 'test') throw new Error(`WEBHOOK_ENCRYPTION_KEY is required when NODE_ENV=${env}`);
    return DEV_KEY;
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('WEBHOOK_ENCRYPTION_KEY must decode to 32 bytes');
  return buf;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decryptSecret(cipher: string): string {
  const [tag0, v, iv, tag, data] = cipher.split(':');
  if (tag0 !== 'enc' || v !== 'v1' || !iv || !tag || !data) throw new Error('not an encrypted secret');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export function isEncryptedSecret(v: string | null | undefined): boolean { return !!v && v.startsWith('enc:v1:'); }
