/**
 * Self-service SANDBOX signup — a bank can try AxLink end to end without waiting for operations.
 *
 * What it does: creates the institution with its SANDBOX environment active and its PRODUCTION
 * environment DISABLED (as every institution starts), and issues one sandbox API key.
 * What it never does: touch production. Real-money access still requires operations to complete KYB,
 * enable the PRODUCTION environment and issue a live key.
 *
 * Guards: only on a sandbox deployment (custody is not live); one sandbox account per email;
 * a per-client rate limit; a daily cap across the deployment.
 */
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { prisma } from '../ledger/ledger.service';
import { ApiError } from '../../shared/errors';
import { log } from '../../shared/logger';
import { createInstitution } from './institution.service';
import { custodyEnvironmentKind } from '../wallets/wallet.service';
import { Password, createPortalUser, createSession } from '../auth/portal-auth.service';

export const SANDBOX_SCOPES = ['wallets:read', 'wallets:write', 'deposits:write', 'deposits:read', 'settlements:read', 'webhooks:write', 'webhooks:read', 'ledger:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write'];

export const SandboxSignup = z.object({
  legalName: z.string().trim().min(2).max(200),
  kind: z.enum(['BANK', 'PSP', 'FINTECH', 'EXCHANGE', 'OTHER']),
  country: z.string().regex(/^[A-Z]{2}$/, 'country: ISO 3166-1 alpha-2'),
  email: z.string().trim().toLowerCase().email().max(200),
  contactName: z.string().trim().min(2).max(120),
  password: Password,
});
export type SandboxSignupInput = z.infer<typeof SandboxSignup>;

/** Sandbox signup is open only where custody is not live, and can be switched off (SANDBOX_SIGNUP=off). */
export function sandboxSignupOpen(): boolean {
  return process.env.SANDBOX_SIGNUP !== 'off' && custodyEnvironmentKind() === 'SANDBOX';
}

const WINDOW_MS = 60 * 60 * 1000;
const PER_CLIENT = Number(process.env.SANDBOX_SIGNUP_PER_HOUR ?? 5);
const recent = new Map<string, number[]>();
export function resetSignupRateLimitForTests() { recent.clear(); }
function allow(client: string): boolean {
  const now = Date.now();
  const hits = (recent.get(client) ?? []).filter(t => now - t < WINDOW_MS);
  if (hits.length >= PER_CLIENT) { recent.set(client, hits); return false; }
  hits.push(now); recent.set(client, hits);
  return true;
}

function slugFor(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'institution';
  return `${base}-${randomBytes(3).toString('hex')}`.replace(/^[^a-z0-9]+/, 'i');
}

export async function signUpSandbox(input: unknown, client: string) {
  if (!sandboxSignupOpen()) throw new ApiError('SIGNUP_CLOSED', 'self-service signup is available on the sandbox only; contact AxLink for production access', 403);
  const d = SandboxSignup.parse(input);
  if (!allow(client)) throw new ApiError('RATE_LIMITED', 'too many signups from this network; try again later', 429);
  const dailyCap = Number(process.env.SANDBOX_SIGNUP_DAILY_CAP ?? 100);
  const today = await prisma.institution.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) }, settings: { path: ['selfSignup'], equals: true } } });
  if (today >= dailyCap) throw new ApiError('SIGNUP_CAPACITY', 'sandbox signups are paused for today; try again tomorrow', 429);
  if (await prisma.institution.findFirst({ where: { contactEmail: d.email }, select: { id: true } }) || await prisma.portalUser.findUnique({ where: { email: d.email }, select: { id: true } })) {
    throw new ApiError('ALREADY_REGISTERED', 'an institution is already registered with this email; sign in with your API key, or contact AxLink to recover it', 409);
  }

  const inst = await createInstitution({ slug: slugFor(d.legalName), legalName: d.legalName, country: d.country, kind: d.kind });
  // Sandbox only: ACTIVE lets the sandbox key authenticate; PRODUCTION stays DISABLED until operations enables it.
  await prisma.institution.update({ where: { id: inst.id }, data: { status: 'ACTIVE', contactEmail: d.email, settings: { selfSignup: true, contactName: d.contactName, signedUpAt: new Date().toISOString() } } });
  // The first person of the institution (ADMIN), signed in at once. API keys for the bank's servers are created
  // later from the dashboard (Developers → API keys); a person never needs one to sign in.
  const user = await createPortalUser(prisma, { institutionId: inst.id, email: d.email, name: d.contactName, password: d.password });
  const session = await createSession(user.id);
  log.info('onboarding.sandbox_signup', { institutionId: inst.id, slug: inst.slug, kind: d.kind, country: d.country, userId: user.id });
  return {
    body: {
      institution: { id: inst.id, slug: inst.slug, legalName: d.legalName },
      environment: 'SANDBOX' as const,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      note: 'Sandbox only: test tokens on Solana devnet, no real money. Production access requires KYB with AxLink operations.',
    },
    session,
  };
}
