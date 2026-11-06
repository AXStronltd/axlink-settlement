/**
 * Institutions (tenants) and their API environments. Foundation only: create, read, list,
 * issue/revoke credentials. No balances, no transactions — those arrive in later steps and
 * will key off `institutionId` + `environmentId` everywhere.
 */
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { prisma } from '../ledger.service';
import { ApiError } from '../../platform/errors';
import { log } from '../../platform/logger';

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
export function getInstitution(id: string) { return prisma.institution.findUnique({ where: { id }, include: { environments: true } }); }
export function listInstitutions() { return prisma.institution.findMany({ orderBy: { createdAt: 'desc' }, include: { environments: true } }); }

export async function issueCredential(institutionId: string, kind: 'SANDBOX' | 'PRODUCTION', label: string, scopes: string[]) {
  const env = await prisma.apiEnvironment.findUnique({ where: { institutionId_kind: { institutionId, kind } } });
  if (!env) throw new ApiError('NOT_FOUND', 'environment not found', 404);
  if (env.status !== 'ACTIVE') throw new ApiError('ENVIRONMENT_DISABLED', `${kind} environment is ${env.status}`, 409);
  const raw = generateRawKey(kind);
  const cred = await prisma.apiCredential.create({ data: { environmentId: env.id, label, prefix: raw.slice(0, 12), keyHash: hashKey(raw), scopes } });
  log.info('credential.issued', { institutionId, environmentId: env.id, credentialId: cred.id, scopes });
  return { credential: cred, rawKey: raw }; // raw key is returned exactly once
}
export async function revokeCredential(id: string) {
  const c = await prisma.apiCredential.update({ where: { id }, data: { revokedAt: new Date() } }); log.info('credential.revoked', { credentialId: id }); return c;
}
/** Resolve a bearer key to its institution + environment. Returns null on any failure (callers answer 401, never say why). */
export async function authenticateKey(raw: string) {
  if (!/^axlk_(test|live)_[A-Za-z0-9_-]{20,}$/.test(raw)) return null;
  const cred = await prisma.apiCredential.findUnique({ where: { prefix: raw.slice(0, 12) }, include: { environment: { include: { institution: true } } } });
  if (!cred || cred.revokedAt || (cred.expiresAt && cred.expiresAt < new Date())) return null;
  if (cred.keyHash !== hashKey(raw)) return null;
  if (cred.environment.status !== 'ACTIVE' || cred.environment.institution.status !== 'ACTIVE') return null;
  prisma.apiCredential.update({ where: { id: cred.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { institution: cred.environment.institution, environment: cred.environment, credential: cred };
}
