/**
 * Operator exception queue (Step 2, slice 6b).
 *
 * Reconciliation finds breaks every run; a transfer sometimes needs a person. Both land here as one
 * open item per (kind, subject, currency) so a recurring break is one line with a count, not a pile.
 * An operator acknowledges (seen, working on it) or resolves (with a note). If the same break shows
 * up again after resolution, a new OPEN item is raised — resolution is a statement about the past.
 *
 * "GET /api/settlement/stuck is empty at the start of each day" and "suspense is zero at close" are
 * the invariants; this queue is where their violations wait for a human.
 */
import { Prisma, type OperationalException } from '@prisma/client';
import { prisma } from '../../core/ledger/ledger.service';
import { ApiError } from '../../shared/errors';
import { log } from '../../shared/logger';

const RANK = { INFO: 0, WARN: 1, CRITICAL: 2 } as const;

export interface RaiseInput {
  kind: string; severity: 'INFO' | 'WARN' | 'CRITICAL'; subject: string; currency?: string | null;
  expected?: Prisma.Decimal | null; actual?: Prisma.Decimal | null; detail?: Prisma.InputJsonValue;
  institutionId?: string | null; entityType?: string | null; entityId?: string | null; runId?: string | null;
}

/** Raise or bump. Returns the open item. Safe to call from inside a transaction. */
export async function raiseException(input: RaiseInput, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<OperationalException> {
  const currency = input.currency ?? null;
  const base = { severity: input.severity, expected: input.expected ?? null, actual: input.actual ?? null, detail: input.detail ?? Prisma.JsonNull, institutionId: input.institutionId ?? null, entityType: input.entityType ?? null, entityId: input.entityId ?? null, lastRunId: input.runId ?? null, lastSeenAt: new Date() };
  // An ACKNOWLEDGED item that recurs stays acknowledged (someone is on it). A recurrence never lowers
  // the severity and never blanks the figures: a transient read failure must not hide a real break.
  const open = await db.operationalException.findFirst({ where: { kind: input.kind, subject: input.subject, currency, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
  const bump = (o: OperationalException) => ({ ...base, severity: RANK[input.severity] >= RANK[o.severity as keyof typeof RANK] ? input.severity : o.severity, expected: input.expected ?? o.expected, actual: input.actual ?? o.actual, occurrences: { increment: 1 } });
  if (open) return db.operationalException.update({ where: { id: open.id }, data: bump(open) });
  try {
    const row = await db.operationalException.create({ data: { kind: input.kind, subject: input.subject, currency, ...base } });
    log.warn('exception.raised', { id: row.id, kind: row.kind, severity: row.severity, subject: row.subject });
    return row;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await db.operationalException.findFirst({ where: { kind: input.kind, subject: input.subject, currency, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
      if (again) return db.operationalException.update({ where: { id: again.id }, data: bump(again) });
    }
    throw e;
  }
}

/** Close the open item for an entity as part of an operator decision taken elsewhere (e.g. a transfer review). */
export async function resolveOpenException(kind: string, subject: string, currency: string | null, by: string, resolution: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  await db.operationalException.updateMany({ where: { kind, subject, currency, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, data: { status: 'RESOLVED', resolvedBy: by, resolvedAt: new Date(), resolution: resolution.slice(0, 1000) } });
}

/** A break that stopped recurring is closed automatically with a note — nobody should chase a ghost. */
export async function autoCloseNotSeenSince(kinds: string[], runId: string, seenSubjects: Set<string>): Promise<number> {
  const open = await prisma.operationalException.findMany({ where: { kind: { in: kinds }, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
  let closed = 0;
  for (const o of open) {
    if (seenSubjects.has(`${o.kind}|${o.subject}|${o.currency ?? ''}`)) continue;
    await prisma.operationalException.update({ where: { id: o.id }, data: { status: 'RESOLVED', resolvedBy: 'reconciliation', resolvedAt: new Date(), resolution: `no longer present in run ${runId}`, lastRunId: runId } });
    closed++;
  }
  return closed;
}

export function listExceptions(q: { status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'ALL'; severity?: string; kind?: string; institutionId?: string; limit?: number } = {}) {
  const status = q.status ?? 'OPEN';
  return prisma.operationalException.findMany({
    where: { ...(status === 'ALL' ? {} : status === 'OPEN' ? { status: { in: ['OPEN', 'ACKNOWLEDGED'] } } : { status }), ...(q.severity ? { severity: q.severity } : {}), ...(q.kind ? { kind: q.kind } : {}), ...(q.institutionId ? { institutionId: q.institutionId } : {}) },
    orderBy: [{ lastSeenAt: 'desc' }], take: Math.min(q.limit ?? 100, 500),
  });
}

export async function acknowledgeException(id: string, by: string) {
  const x = await prisma.operationalException.findUnique({ where: { id } });
  if (!x) throw new ApiError('NOT_FOUND', 'exception not found', 404);
  if (x.status !== 'OPEN') throw new ApiError('NOT_OPEN', `exception is ${x.status}`, 409);
  return prisma.operationalException.update({ where: { id }, data: { status: 'ACKNOWLEDGED', acknowledgedBy: by, acknowledgedAt: new Date() } });
}

export async function resolveException(id: string, by: string, resolution: string) {
  const x = await prisma.operationalException.findUnique({ where: { id } });
  if (!x) throw new ApiError('NOT_FOUND', 'exception not found', 404);
  if (x.status === 'RESOLVED') throw new ApiError('ALREADY_RESOLVED', 'exception is already resolved', 409);
  if (!resolution.trim()) throw new ApiError('VALIDATION_ERROR', 'a resolution note is required', 400);
  const r = await prisma.operationalException.update({ where: { id }, data: { status: 'RESOLVED', resolvedBy: by, resolvedAt: new Date(), resolution: resolution.trim().slice(0, 1000) } });
  log.info('exception.resolved', { id, by, kind: r.kind });
  return r;
}

export async function exceptionSummary() {
  const rows = await prisma.operationalException.groupBy({ by: ['severity', 'status'], _count: { _all: true }, where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
  const out = { open: 0, acknowledged: 0, critical: 0, warn: 0, info: 0 };
  for (const r of rows) { const n = r._count._all; if (r.status === 'OPEN') out.open += n; else out.acknowledged += n; if (r.severity === 'CRITICAL') out.critical += n; else if (r.severity === 'WARN') out.warn += n; else out.info += n; }
  return out;
}

export function serializeException(x: OperationalException) {
  return { id: x.id, kind: x.kind, severity: x.severity, status: x.status, subject: x.subject, currency: x.currency, expected: x.expected?.toFixed() ?? null, actual: x.actual?.toFixed() ?? null, detail: x.detail, institutionId: x.institutionId, entity: x.entityType ? { type: x.entityType, id: x.entityId } : null, occurrences: x.occurrences, firstSeenAt: x.firstSeenAt, lastSeenAt: x.lastSeenAt, acknowledged: x.acknowledgedAt ? { by: x.acknowledgedBy, at: x.acknowledgedAt } : null, resolved: x.resolvedAt ? { by: x.resolvedBy, at: x.resolvedAt, note: x.resolution } : null };
}
