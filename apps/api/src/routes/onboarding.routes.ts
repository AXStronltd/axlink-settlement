/**
 * Public, unauthenticated: self-service SANDBOX signup (packages/core/institutions/onboarding.service.ts).
 *   POST /api/v1/onboarding/sandbox   { legalName, kind, country, email, contactName } → institution + sandbox key (once)
 *   GET  /api/v1/onboarding/sandbox   { open: boolean } — whether this deployment accepts self-service signup
 */
import { Router } from 'express';
import { signUpSandbox, sandboxSignupOpen } from '../../../../packages/core/institutions/onboarding.service';
import { sessionCookie } from '../../../../packages/core/auth/portal-auth.service';
import { secureRequest } from './portal-auth.routes';

const router = Router();
const wrap = (fn: (req: import('express').Request, res: import('express').Response) => Promise<void>) =>
  (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => { fn(req, res).catch(next); };

/** The rate-limit key only: Render terminates TLS at a proxy, so the client is the first X-Forwarded-For hop. */
function clientOf(req: import('express').Request): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

router.get('/sandbox', (_req, res) => { res.json({ open: sandboxSignupOpen() }); });
router.post('/sandbox', wrap(async (req, res) => {
  const r = await signUpSandbox(req.body, clientOf(req));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', sessionCookie(r.session.token, r.session.expiresAt, secureRequest(req)));
  res.status(201).json(r.body);
}));

export default router;
