/**
 * Service authentication for the settlement API.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS
 *
 *  AxLink Settlement is infrastructure, not a product. It has no end users:
 *  its callers are other services — the banking platform that holds the
 *  customer relationship, and the ops tooling. There is no app layer in front
 *  of it doing authentication on its behalf, so these routes are the boundary.
 *
 *  They were open. `POST /api/orchestrator/payout-rail/fiat-arrived` is how
 *  money enters the ledger, and anything that could reach the port could
 *  credit an arbitrary account with an arbitrary amount. Transfers,
 *  withdrawals and account creation were reachable the same way.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Deliberately separate from OPS_API_KEY. That key is for treasury and
 * settlement operations — rebalancing float, resolving reconciliation breaks —
 * and must not be handed to the platform that merely wants to move a customer's
 * money. Two callers with different privileges get two credentials.
 *
 * Also separate from `requireBankAuth`, which authenticates *member banks* on
 * the AxLink Network API against rows in the Bank table. The platform is not a
 * member bank; it is the system this network exists to serve.
 */

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto';

/**
 * Constant-time comparison.
 *
 * A plain `===` on a secret leaks its prefix through timing: an attacker who
 * can measure the difference learns the key one character at a time. Node's
 * timingSafeEqual throws on length mismatch, which would leak the length, so
 * the length is checked first and separately.
 */
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return cryptoTimingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Require the platform service credential.
 *
 * Fails closed. An unset key disables these endpoints rather than opening
 * them: a settlement network that accepts unauthenticated instructions because
 * of a missing environment variable is worse than one that is briefly
 * unavailable, and the failure is loud enough to be fixed immediately.
 *
 * The one exception is the local development path — see `allowUnauthenticated`.
 */
export function requireServiceAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.SETTLEMENT_API_KEY ?? '';

  if (!expected) {
    if (allowUnauthenticated()) {
      next();
      return;
    }
    res.status(503).json({
      error:
        'SETTLEMENT_API_KEY is not configured — money-moving endpoints are disabled. ' +
        'Set it to the credential the calling platform presents.',
      code: 'MISCONFIGURED',
    });
    return;
  }

  const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!provided || !secretsMatch(provided, expected)) {
    res.status(401).json({ error: 'Service authentication required', code: 'UNAUTHORIZED' });
    return;
  }

  next();
}

/**
 * Whether an unkeyed request may proceed.
 *
 * True only when running outside production *and* the operator has opted in
 * explicitly. Two conditions rather than one, because `NODE_ENV` is unset far
 * more often than it is set to "production" — a staging box, a container with
 * a truncated env, a script run by hand. Treating "not production" as
 * permission would leave the most likely misconfiguration wide open.
 *
 * Read per call rather than captured at import, so the guard cannot be
 * side-stepped by setting the variable after the module loads.
 */
function allowUnauthenticated(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_UNAUTHENTICATED_SETTLEMENT === 'true'
  );
}

/** Log the posture once at boot, so an open instance is visible in the log. */
export function reportAuthPosture(): void {
  if (process.env.SETTLEMENT_API_KEY) return;

  if (allowUnauthenticated()) {
    console.warn(
      '[startup] Money-moving endpoints are UNAUTHENTICATED — ' +
      'ALLOW_UNAUTHENTICATED_SETTLEMENT=true and no SETTLEMENT_API_KEY. ' +
      'Local development only. Never set this where the service is reachable.',
    );
  } else {
    console.warn(
      '[startup] SETTLEMENT_API_KEY is not set — money-moving endpoints will return 503. ' +
      'Set it, or set ALLOW_UNAUTHENTICATED_SETTLEMENT=true for local development.',
    );
  }
}
