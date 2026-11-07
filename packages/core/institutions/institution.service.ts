/**
 * Institutions (tenants) and their API environments. Foundation only: create, read, list,
 * issue/revoke credentials. No balances, no transactions — those arrive in later steps and
 * will key off `institutionId` + `environmentId` everywhere.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { prisma } from '../ledger/ledger.service';
import { ApiError } from '../../shared/errors';
import { log } from '../../shared/logger';

export const CreateInstitution = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,48}$/, 'slug: lowercase letters, digits, hyphens'),
  legalName: z.string().min(2).max(200),
  country: z.string().regex(/^[A-Z]{2}$/, 'country: ISO 3166-1 alpha-2'),
  kind: z.enum(['BANK', 'FINTECH', 'PSP', 'EXCHANGE', 'OTHER']),
  contactEmail: z.string().email().optional(),
});
export type CreateInstitutionInput = z.infer<typeof CreateInstitution>;

const PEPPER = () => process.env.API_KEY_PEPPER ?? ''; // optional server-side pepper; rotate with care (re-issue keys)
export function hashKey(raw: string) { return createHash('sha256').update(raw + PEPPER()).digest('hex'); }

/**
 * Lookup prefix: `axlk_test_` / `axlk_live_` (10 chars) + the first 10 random characters (~60 bits).
 * The original 12-char prefix carried only 2 random characters (4,096 values) under a unique index,
 * so issuance started failing with collisions after a few hundred keys. Keys issued before this
 * change are found by their stored 12-char prefix (see authenticateKey).
 */
export const PREFIX_LEN = 20;
const LEGACY_PREFIX_LEN = 12;
export function keyPrefix(raw: string) { return raw.slice(0, PREFIX_LEN); }

/** Raw key format: axlk_<env>_<32 url-safe chars>. Prefix (first 12 chars) is the lookup key. */
export function generateRawKey(kind: 'SANDBOX' | 'PRODUCTION') {
  return `axlk_${kind === 'SANDBOX' ? 'test' : 'live'}_${randomBytes(24).toString('base64url')}`;
}

export async function createInstitution(input: CreateInstitutionInput) {
  const data = CreateInstitution.parse(input);
  const existing = await prisma.institution.findUnique({ where: { slug: data.slug } });
  if (existing) throw new ApiError('INSTITUTION_EXISTS', `institution ${data.slug} already exists`, 409);
  // every institution starts with both environments; sandbox active, production disabled until go-live
  const inst = await prisma.institution.create({ data: { ...data, environments: { create: [{ kind: 'SANDBOX', status: 'ACTIVE' }, { kind: 'PRODUCTION', status: 'DISABLED' }] } }, include: { environments: true } });
  log.info('institution.created', { institutionId: inst.id, slug: inst.slug });
  return inst;
}
/**
 * Operations moves an institution through onboarding. Nothing works for a PENDING institution (no
 * credentials, no wallets); ACTIVE is the go-live decision; SUSPENDED stops it without deleting
 * anything. CLOSED is terminal. Every change is logged with who asked and why.
 */
const STATUS_MOVES: Record<string, string[]> = { PENDING: ['ACTIVE', 'CLOSED'], ACTIVE: ['SUSPENDED', 'CLOSED'], SUSPENDED: ['ACTIVE', 'CLOSED'], CLOSED: [] };
export async function setInstitutionStatus(id: string, status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED', reason: string, actor = 'ops') {
  const inst = await prisma.institution.findUnique({ where: { id } });
  if (!inst) throw new ApiError('NOT_FOUND', 'institution not found', 404);
  if (inst.status === status) return inst;
  if (!STATUS_MOVES[inst.status]?.includes(status)) throw new ApiError('INVALID_STATUS_CHANGE', `institution is ${inst.status}; it cannot become ${status}`, 409);
  // Conditional on the status we checked: two concurrent changes cannot both pass (CLOSED stays terminal).
  const moved = await prisma.institution.updateMany({ where: { id, status: inst.status }, data: { status } });
  if (moved.count !== 1) throw new ApiError('STATUS_CHANGED', 'institution status changed concurrently; re-read and retry', 409);
  const updated = (await prisma.institution.findUnique({ where: { id } }))!;
  log.info('institution.status_changed', { institutionId: id, from: inst.status, to: status, reason, actor });
  return updated;
}

export function getInstitution(id: string) { return prisma.institution.findUnique({ where: { id }, include: { environments: true } }); }
export function listInstitutions() { return prisma.institution.findMany({ orderBy: { createdAt: 'desc' }, include: { environments: true } }); }

export async function issueCredential(institutionId: string, kind: 'SANDBOX' | 'PRODUCTION', label: string, scopes: string[]) {
  const env = await prisma.apiEnvironment.findUnique({ where: { institutionId_kind: { institutionId, kind } } });
  if (!env) throw new ApiError('NOT_FOUND', 'environment not found', 404);
  // Keys are handed over only after onboarding: a PENDING or SUSPENDED institution gets none (its keys would not authenticate anyway).
  const inst = await prisma.institution.findUnique({ where: { id: institutionId }, select: { status: true } });
  if (!inst || inst.status !== 'ACTIVE') throw new ApiError('INSTITUTION_INACTIVE', `institution is ${inst?.status ?? 'missing'}; complete onboarding and activate it before issuing keys`, 409);
  if (env.status !== 'ACTIVE') throw new ApiError('ENVIRONMENT_DISABLED', `${kind} environment is ${env.status}`, 409);
  const raw = generateRawKey(kind);
  const cred = await prisma.apiCredential.create({ data: { environmentId: env.id, label, prefix: keyPrefix(raw), keyHash: hashKey(raw), scopes } });
  log.info('credential.issued', { institutionId, environmentId: env.id, credentialId: cred.id, scopes });
  return { credential: cred, rawKey: raw }; // raw key is returned exactly once
}
export async function revokeCredential(id: string) {
  const c = await prisma.apiCredential.update({ where: { id }, data: { revokedAt: new Date() } }); log.info('credential.revoked', { credentialId: id }); return c;
}
/** Resolve a bearer key to its institution + environment. Returns null on any failure (callers answer 401, never say why). */
export async function authenticateKey(raw: string) {
  if (!/^axlk_(test|live)_[A-Za-z0-9_-]{20,}$/.test(raw)) return null;
  const include = { environment: { include: { institution: true } } } as const;
  const cred = await prisma.apiCredential.findUnique({ where: { prefix: keyPrefix(raw) }, include })
    ?? await prisma.apiCredential.findUnique({ where: { prefix: raw.slice(0, LEGACY_PREFIX_LEN) }, include }); // keys issued before PREFIX_LEN=20
  if (!cred || cred.revokedAt || (cred.expiresAt && cred.expiresAt < new Date())) return null;
  const expect = Buffer.from(cred.keyHash, 'hex'); const got = Buffer.from(hashKey(raw), 'hex');
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
  if (cred.environment.status !== 'ACTIVE' || cred.environment.institution.status !== 'ACTIVE') return null;
  prisma.apiCredential.update({ where: { id: cred.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { institution: cred.environment.institution, environment: cred.environment, credential: cred };
}
