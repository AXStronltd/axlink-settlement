/**
 * Webhook admission policy (remediation F2).
 *
 * A webhook is a request to change financial state. It is admitted only when its signature has
 * been verified against the raw request body with the provider's configured key. When no key is
 * configured the endpoint fails CLOSED (503, nothing processed) — the old "skip verification in
 * dev mode" behaviour let an unauthenticated POST mint ledger balance.
 *
 * Signature admission cannot be bypassed in any environment; sandbox tests use test keys.
 */
import type { Request, Response } from 'express';
import { log } from '../shared/logger';

export type WebhookVerdict = { ok: true } | { ok: false; status: 401 | 503; code: string; message: string };

export function isUnverifiedAllowed(): boolean {
  return process.env.ALLOW_UNVERIFIED_WEBHOOKS === 'true' && process.env.NODE_ENV !== 'production';
}

/** Treat empty strings and `.env.example` placeholders (`your_…`) as "not configured". */
export function isSecretConfigured(value: string | undefined): boolean {
  return !!value && value.length > 0 && !/^your_/i.test(value);
}

export function admitWebhook(opts: {
  provider: string;
  secretConfigured: boolean;
  signaturePresent: boolean;
  verify: () => boolean;
}): WebhookVerdict {
  const { provider } = opts;
  if (!opts.secretConfigured) {
    log.error('webhook.rejected', { provider, reason: 'verification key not configured' });
    return { ok: false, status: 503, code: 'WEBHOOK_NOT_CONFIGURED', message: `${provider} webhook verification is not configured; event refused` };
  }
  if (!opts.signaturePresent) {
    log.warn('webhook.rejected', { provider, reason: 'missing signature' });
    return { ok: false, status: 401, code: 'WEBHOOK_SIGNATURE_MISSING', message: 'Missing webhook signature' };
  }
  let valid = false;
  try { valid = opts.verify(); } catch { valid = false; }
  if (!valid) {
    log.warn('webhook.rejected', { provider, reason: 'invalid signature' });
    return { ok: false, status: 401, code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid webhook signature' };
  }
  return { ok: true };
}

/** Raw body as captured by the express.json `verify` hook in src/index.ts. Empty when absent. */
export function rawBodyOf(req: Request): string {
  return (req as Request & { rawBody?: string }).rawBody ?? '';
}

export function rejectWebhook(res: Response, verdict: Exclude<WebhookVerdict, { ok: true }>): void {
  res.status(verdict.status).json({ error: verdict.message, code: verdict.code });
}
