/**
 * Institution portal sign-in for PEOPLE (email + password → session cookie). API keys remain the way a
 * bank's SERVERS authenticate; people never paste one into the browser.
 *
 * - Passwords: scrypt with a per-user salt, stored as `scrypt$N$r$p$salt$hash`; verified in constant time.
 * - Sessions: a 32-byte random token in an HttpOnly, Secure, SameSite=Strict cookie; only its SHA-256 is
 *   stored. Sliding expiry (12h idle, 7d absolute). Revoked on sign-out.
 * - Brute force: 5 failed attempts lock the account for 15 minutes; failures answer the same generic
 *   message whether or not the email exists.
 * - A portal session reaches its institution's SANDBOX environment only. Production access is operator-only.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { z } from 'zod';
import { prisma } from '../ledger/ledger.service';
import { ApiError } from '../../shared/errors';
import { log } from '../../shared/logger';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, LEN = 32;
export const SESSION_COOKIE = 'axs';
const IDLE_MS = 12 * 3600_000, ABSOLUTE_MS = 7 * 24 * 3600_000;
const MAX_FAILS = 5, LOCK_MS = 15 * 60_000;

export const Password = z.string().min(12, 'password must be at least 12 characters').max(200)
  .refine(p => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), 'password must contain letters and digits');

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, LEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

export async function createPortalUser(tx: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0], input: { institutionId: string; email: string; name: string; password: string }) {
  const password = Password.parse(input.password);
  return tx.portalUser.create({ data: { institutionId: input.institutionId, email: input.email.toLowerCase(), name: input.name, passwordHash: await hashPassword(password) } });
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + IDLE_MS);
  await prisma.portalSession.create({ data: { tokenHash: tokenHash(token), userId, expiresAt } });
  return { token, expiresAt };
}

const GENERIC = () => new ApiError('INVALID_CREDENTIALS', 'email or password is incorrect', 401);
// A dummy hash so an unknown email costs the same scrypt work as a known one (no user-enumeration by timing).
let dummy: Promise<string> | null = null;

export async function login(emailRaw: string, password: string) {
  const email = String(emailRaw ?? '').trim().toLowerCase();
  const user = email ? await prisma.portalUser.findUnique({ where: { email }, include: { institution: { select: { status: true, slug: true } } } }) : null;
  if (!user) { await verifyPassword(String(password ?? ''), await (dummy ??= hashPassword('dummy-password-0'))); throw GENERIC(); }
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new ApiError('ACCOUNT_LOCKED', 'too many failed attempts; try again in a few minutes', 429);
  const ok = await verifyPassword(String(password ?? ''), user.passwordHash);
  if (!ok) {
    const fails = user.failedLogins + 1;
    await prisma.portalUser.update({ where: { id: user.id }, data: { failedLogins: fails >= MAX_FAILS ? 0 : fails, lockedUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS) : user.lockedUntil } });
    log.warn('portal.login_failed', { userId: user.id, fails });
    throw GENERIC();
  }
  if (user.status !== 'ACTIVE' || user.institution.status !== 'ACTIVE') throw new ApiError('ACCOUNT_DISABLED', 'this account is not active; contact AxLink', 403);
  await prisma.portalUser.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  log.info('portal.login', { userId: user.id, institutionId: user.institutionId });
  return { user, session: await createSession(user.id) };
}

/** Resolve a session cookie to its user + SANDBOX environment, sliding the idle expiry. Null on any failure. */
export async function sessionTenant(token: string | undefined) {
  if (!token || token.length < 20) return null;
  const s = await prisma.portalSession.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: { include: { institution: { include: { environments: true } } } } } });
  if (!s || s.revokedAt || s.expiresAt <= new Date() || Date.now() - s.createdAt.getTime() > ABSOLUTE_MS) return null;
  const u = s.user; const inst = u.institution;
  if (u.status !== 'ACTIVE' || inst.status !== 'ACTIVE') return null;
  const env = inst.environments.find(e => e.kind === 'SANDBOX' && e.status === 'ACTIVE');
  if (!env) return null;
  if (s.expiresAt.getTime() - Date.now() < IDLE_MS - 5 * 60_000) {
    await prisma.portalSession.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() + IDLE_MS), lastSeenAt: new Date() } });
  }
  return { sessionId: s.id, user: { id: u.id, email: u.email, name: u.name, role: u.role }, institution: { id: inst.id, slug: inst.slug, legalName: inst.legalName }, environment: env };
}

export async function revokeSession(token: string | undefined) {
  if (!token) return;
  await prisma.portalSession.updateMany({ where: { tokenHash: tokenHash(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Cookie header for the session (Secure unless the request is plain http on localhost). */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${expiresAt.toUTCString()}${secure ? '; Secure' : ''}`;
}
export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); }
  return undefined;
}
