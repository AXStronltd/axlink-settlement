/**
 * Tenant context for institution-facing routes. Every request carries exactly one institution and
 * one environment (sandbox or production); services must scope every query by them.
 * Not yet applied to the legacy customer routes — see docs/AUDIT-STEP1.md (Step 2 scope).
 */
import type { Request, Response, NextFunction } from 'express';
import { authenticateKey } from '../institutions/institution.service';
import { unauthorized, forbidden } from '../../shared/errors';
import { log } from '../../shared/logger';
import { SESSION_COOKIE, readCookie, sessionTenant } from '../auth/portal-auth.service';
import { SANDBOX_SCOPES } from '../institutions/onboarding.service';

export interface TenantContext { institutionId: string; institutionSlug: string; environmentId: string; environmentKind: 'SANDBOX' | 'PRODUCTION'; scopes: string[]; credentialId: string; }
declare global { namespace Express { interface Request { tenant?: TenantContext } } }

export async function requireInstitution(req: Request, _res: Response, next: NextFunction) {
  if (req.tenant) return next(); // already authenticated by an enclosing router (/api/v1)
  const header = req.headers.authorization ?? '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw) {
    // A person signed in to the portal: HttpOnly session cookie, SANDBOX environment only.
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) {
      // CSRF: a state-changing request authenticated by cookie must carry the portal's own header, which a
      // cross-site form or image cannot send (and SameSite=Strict already withholds the cookie cross-site).
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-axlink-portal'] !== '1') return next(forbidden('portal requests must carry X-AxLink-Portal: 1'));
      const s = await sessionTenant(token).catch(() => null);
      if (!s) return next(unauthorized('Session expired; sign in again'));
      req.tenant = { institutionId: s.institution.id, institutionSlug: s.institution.slug, environmentId: s.environment.id, environmentKind: 'SANDBOX', scopes: SANDBOX_SCOPES, credentialId: `session:${s.sessionId}` };
      log.setInstitution(s.institution.id);
      return next();
    }
  }
  const auth = raw ? await authenticateKey(raw) : null;
  if (!auth) return next(unauthorized('Invalid or missing API key'));
  req.tenant = { institutionId: auth.institution.id, institutionSlug: auth.institution.slug, environmentId: auth.environment.id, environmentKind: auth.environment.kind, scopes: auth.credential.scopes, credentialId: auth.credential.id };
  log.setInstitution(auth.institution.id);
  next();
}
export const requireScope = (...needed: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  const have = req.tenant?.scopes ?? [];
  const ok = needed.every(s => have.includes(s) || have.includes(s.split(':')[0] + ':*') || have.includes('*'));
  next(ok ? undefined : forbidden(`missing scope ${needed.join(',')}`));
};
