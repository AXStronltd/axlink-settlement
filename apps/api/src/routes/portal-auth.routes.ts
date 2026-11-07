/**
 * Portal sign-in for people (packages/core/auth/portal-auth.service.ts) and the dashboard's API-key management.
 *   POST /api/v1/auth/login     { email, password } → HttpOnly session cookie
 *   POST /api/v1/auth/logout    → session revoked, cookie cleared
 *   GET  /api/v1/auth/session   → { user, institution, environment } or 401
 *   GET  /api/v1/portal/credentials            (signed-in person only) list this institution's sandbox keys
 *   POST /api/v1/portal/credentials { label }  (signed-in person only) create a sandbox key — shown once
 *   POST /api/v1/portal/credentials/:id/revoke (signed-in person only)
 * Keys cannot create keys: the credential routes refuse Bearer authentication.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { login, revokeSession, sessionTenant, sessionCookie, clearedSessionCookie, readCookie, SESSION_COOKIE } from '../../../../packages/core/auth/portal-auth.service';
import { issueCredential, revokeCredential } from '../../../../packages/core/institutions/institution.service';
import { SANDBOX_SCOPES } from '../../../../packages/core/institutions/onboarding.service';
import { prisma } from '../../../../packages/core/ledger/ledger.service';
import { requireInstitution } from '../../../../packages/core/tenancy/tenancy.middleware';
import { ApiError } from '../../../../packages/shared/errors';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
/** Secure cookies everywhere except plain-http localhost development. */
export function secureRequest(req: Request): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || (req.secure ? 'https' : 'http');
  return proto === 'https' || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host ?? ''));
}

export const authRoutes = Router();
const Login = z.object({ email: z.string().max(200), password: z.string().max(200) });
authRoutes.post('/login', wrap(async (req, res) => {
  const b = Login.parse(req.body);
  const { user, session } = await login(b.email, b.password);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', sessionCookie(session.token, session.expiresAt, secureRequest(req)));
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}));
authRoutes.post('/logout', wrap(async (req, res) => {
  await revokeSession(readCookie(req.headers.cookie, SESSION_COOKIE));
  res.setHeader('Set-Cookie', clearedSessionCookie(secureRequest(req)));
  res.status(204).end();
}));
authRoutes.get('/session', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = await sessionTenant(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!s) throw new ApiError('UNAUTHORIZED', 'not signed in', 401);
  res.json({ user: s.user, institution: s.institution, environment: 'SANDBOX' });
}));

export const portalRoutes = Router();
portalRoutes.use(requireInstitution, (req, _res, next) => {
  next(req.tenant?.credentialId.startsWith('session:') ? undefined : new ApiError('FORBIDDEN', 'API keys are managed by a signed-in person in the portal, not by another key', 403));
});
const CreateKey = z.object({ label: z.string().trim().min(1).max(80) });
portalRoutes.get('/credentials', wrap(async (req, res) => {
  const rows = await prisma.apiCredential.findMany({ where: { environmentId: req.tenant!.environmentId }, orderBy: { createdAt: 'desc' } });
  res.json(rows.map(c => ({ id: c.id, label: c.label, prefix: c.prefix, scopes: c.scopes, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, revokedAt: c.revokedAt })));
}));
portalRoutes.post('/credentials', wrap(async (req, res) => {
  const b = CreateKey.parse(req.body);
  const r = await issueCredential(req.tenant!.institutionId, 'SANDBOX', b.label, SANDBOX_SCOPES);
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ id: r.credential.id, label: r.credential.label, prefix: r.credential.prefix, scopes: r.credential.scopes, apiKey: r.rawKey, note: 'Shown once. Store it in your server\'s secret manager.' });
}));
portalRoutes.post('/credentials/:id/revoke', wrap(async (req, res) => {
  const c = await prisma.apiCredential.findFirst({ where: { id: req.params.id as string, environmentId: req.tenant!.environmentId } });
  if (!c) throw new ApiError('NOT_FOUND', 'credential not found', 404);
  await revokeCredential(c.id);
  res.json({ id: c.id, revoked: true });
}));
