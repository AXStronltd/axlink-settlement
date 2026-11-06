/**
 * Fail-closed admission for legacy customer APIs (F4).
 * These records have institution ownership but no environment key. All institution
 * credentials are denied, including sandbox and wildcard credentials. Operators
 * retain reads and non-production user provisioning only; financial mutations
 * are disabled until separately approved, environment-scoped APIs exist.
 * The ownership guard below is retained as defense in depth for future approved wiring.
 */
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { prisma } from '../ledger/ledger.service';
import { authenticateKey } from '../institutions/institution.service';
import { config } from '../../shared/config';
import { unauthorized, notFound, forbidden } from '../../shared/errors';
import { log } from '../../shared/logger';

export type Actor = { kind: 'ops' } | { kind: 'institution'; institutionId: string };
declare global { namespace Express { interface Request { actor?: Actor } } }

function isOpsKey(provided: string): boolean {
  const expected = config().OPS_API_KEY ?? '';
  if (!expected || !provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Authenticate as operator or institution. 401 otherwise. */
export async function requireCustomerActor(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw) return next(unauthorized('Authentication required: operator key or institution API key'));
  if (isOpsKey(raw)) {
    // The legacy transfer/FX/payout handlers are not a verified Leg A API.
    // Keep read access and local user provisioning for the preserved dashboard,
    // but do not expose unsafe financial mutations while their replacements await approval.
    const path = (req.baseUrl + req.path).replace(/\/$/, '');
    const localProvisioning = req.method === 'POST' && path === '/api/users' && process.env.NODE_ENV !== 'production';
    if (!['GET', 'HEAD'].includes(req.method) && !localProvisioning) {
      return next(Object.assign(new Error('Legacy financial mutation endpoint disabled in Leg A'), { code: 'LEGACY_FINANCIAL_API_DISABLED', statusCode: 503 }));
    }
    req.actor = { kind: 'ops' }; return next();
  }
  const auth = await authenticateKey(raw);
  if (!auth) return next(unauthorized('Invalid API key'));
  // Even sandbox reads are unsafe: legacy rows do not carry an API environment.
  // Disable institution access instead of inventing isolation without a data boundary.
  return next(forbidden('Legacy institutional APIs are disabled until environment-scoped ownership is available'));

}

const USER_ID_KEYS = ['userId', 'senderId', 'receiverId'] as const;

function collect(req: Request): { userIds: string[]; entityIds: string[] } {
  const userIds = new Set<string>(); const entityIds = new Set<string>();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = req.query as Record<string, unknown>;
  const params = req.params as Record<string, string | undefined>;
  for (const k of USER_ID_KEYS) {
    for (const src of [body, query, params]) { const v = src[k]; if (typeof v === 'string' && v) userIds.add(v); }
  }
  // Router-level middleware sees no `:id` params, so the id is read from the path itself:
  // `/users/<id>[/...]` names a user; `/transfers|withdrawals|deposits|crypto/<id>` name a record.
  const segments = (req.baseUrl + req.path).split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i], next = segments[i + 1];
    if (seg === 'users' && next !== 'lookup') { userIds.add(decodeURIComponent(next)); break; }
    if ((seg === 'transfers' || seg === 'withdrawals' || seg === 'deposits' || seg === 'crypto') && !['bank', 'buy', 'initiate', 'methods'].includes(next)) { entityIds.add(decodeURIComponent(next)); break; }
  }
  void params;
  return { userIds: [...userIds], entityIds: [...entityIds] };
}

async function ownerOfEntity(id: string): Promise<string | null> {
  const [t, w, d, c] = await Promise.all([
    prisma.transfer.findUnique({ where: { id }, select: { senderId: true } }),
    prisma.withdrawal.findUnique({ where: { id }, select: { userId: true } }),
    prisma.bankDeposit.findUnique({ where: { id }, select: { userId: true } }),
    prisma.cryptoBuy.findUnique({ where: { id }, select: { userId: true } }).catch(() => null),
  ]);
  return t?.senderId ?? w?.userId ?? d?.userId ?? c?.userId ?? null;
}

/** After requireCustomerActor. Institutions may only name their own customers and records. */
export async function tenantGuard(req: Request, _res: Response, next: NextFunction) {
  const actor = req.actor;
  if (!actor) return next(unauthorized());
  if (actor.kind === 'ops') return next();
  const { userIds, entityIds } = collect(req);
  const owners = new Set(userIds);
  for (const id of entityIds) {
    const owner = await ownerOfEntity(id);
    if (!owner) return next(notFound('record'));
    owners.add(owner);
  }
  if (owners.size === 0) return next();
  const users = await prisma.user.findMany({ where: { id: { in: [...owners] } }, select: { id: true, institutionId: true } });
  const byId = new Map(users.map(u => [u.id, u.institutionId]));
  for (const id of owners) {
    if (byId.get(id) !== actor.institutionId) {
      log.warn('tenant.denied', { institutionId: actor.institutionId, entity: id });
      return next(notFound('record'));
    }
  }
  next();
}

/** Both, in order — mount on every legacy customer router. */
export const protectCustomerApi = [requireCustomerActor, tenantGuard];

/** The institution a newly created customer belongs to (null for the operator). */
export function actorInstitutionId(req: Request): string | null {
  return req.actor?.kind === 'institution' ? req.actor.institutionId : null;
}
