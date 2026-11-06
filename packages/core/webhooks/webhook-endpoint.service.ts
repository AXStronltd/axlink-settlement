/**
 * Institution webhook endpoints (Step 2, slice 2).
 * Secret shown once; stored encrypted; used by the outbox to sign deliveries as
 *   X-AxLink-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
 */
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../ledger/ledger.service';
import { encryptSecret } from '../../shared/secrets';
import { enqueue } from '../events/outbox.service';
import { ApiError } from '../../shared/errors';

export const INSTITUTION_EVENTS = ['deposit.settled', 'deposit.expired'] as const;
export type InstitutionEvent = typeof INSTITUTION_EVENTS[number];

export async function createEndpoint(scope: { institutionId: string; environmentId: string }, url: string, events: string[] = ['*']) {
  let u: URL; try { u = new URL(url); } catch { throw new ApiError('INVALID_URL', 'url must be absolute', 400); }
  if (u.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && u.protocol === 'http:')) throw new ApiError('INVALID_URL', 'webhook url must use https', 400);
  for (const e of events) if (e !== '*' && !(INSTITUTION_EVENTS as readonly string[]).includes(e)) throw new ApiError('UNKNOWN_EVENT', `unknown event ${e}`, 400);
  const count = await prisma.webhookEndpoint.count({ where: { ...scope, status: 'ACTIVE' } });
  if (count >= 10) throw new ApiError('LIMIT', 'at most 10 active endpoints per environment', 409);
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const ep = await prisma.webhookEndpoint.create({ data: { ...scope, url, events, secretCiphertext: encryptSecret(secret) } });
  return { endpoint: serializeEndpoint(ep), secret };
}

export function listEndpoints(scope: { institutionId: string; environmentId: string }) {
  return prisma.webhookEndpoint.findMany({ where: scope, orderBy: { createdAt: 'asc' } }).then(r => r.map(serializeEndpoint));
}

export async function disableEndpoint(id: string, scope: { institutionId: string; environmentId: string }) {
  const r = await prisma.webhookEndpoint.updateMany({ where: { id, ...scope }, data: { status: 'DISABLED' } });
  if (r.count !== 1) throw new ApiError('NOT_FOUND', 'endpoint not found', 404);
}

export function serializeEndpoint(e: { id: string; url: string; events: string[]; status: string; createdAt: Date }) {
  return { id: e.id, url: e.url, events: e.events, status: e.status, createdAt: e.createdAt };
}

/**
 * Fan an event out to every active endpoint of the institution+environment, inside the caller's
 * transaction so the event cannot outlive a rolled-back state change (or be lost for a committed one).
 */
export async function emitInstitutionEvent(tx: Prisma.TransactionClient, scope: { institutionId: string; environmentId: string }, type: InstitutionEvent, data: Prisma.InputJsonValue, entity: { entityType: string; entityId: string }) {
  const endpoints = await tx.webhookEndpoint.findMany({ where: { ...scope, status: 'ACTIVE' } });
  const eventId = `evt_${randomBytes(12).toString('base64url')}`;
  for (const ep of endpoints) {
    if (!ep.events.includes('*') && !ep.events.includes(type)) continue;
    await enqueue(tx, {
      channel: 'institution.webhook', eventType: type, targetUrl: ep.url, targetSecret: ep.secretCiphertext,
      payload: { id: eventId, type, createdAt: new Date().toISOString(), environment: undefined, data } as Prisma.InputJsonValue,
      ...entity, maxAttempts: 6,
    });
  }
  return eventId;
}
