/**
 * Tenant context for institution-facing routes. Every request carries exactly one institution and
 * one environment (sandbox or production); services must scope every query by them.
 * Not yet applied to the legacy customer routes — see docs/AUDIT-STEP1.md (Step 2 scope).
 */
import type { Request, Response, NextFunction } from 'express';
import { authenticateKey } from '../institutions/institution.service';
import { unauthorized, forbidden } from '../../platform/errors';
import { log } from '../../platform/logger';

export interface TenantContext { institutionId: string; institutionSlug: string; environmentId: string; environmentKind: 'SANDBOX' | 'PRODUCTION'; scopes: string[]; credentialId: string; }
declare global { namespace Express { interface Request { tenant?: TenantContext } } }

export async function requireInstitution(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
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
