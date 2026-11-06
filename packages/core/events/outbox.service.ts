/**
 * Transactional outbox for outbound webhooks.
 *
 * `initiateInterbankTransfer` dispatched member-bank webhooks with a floating
 * `.then()` and never incremented `webhookAttempts`. A process restart or a
 * partner returning 500 lost the notification permanently — and on this network
 * the webhook is how a receiving bank learns it has money, so that is a
 * correctness bug rather than an operational annoyance.
 *
 * The fix is ordinary and well-worn: write the event row in the *same*
 * transaction as the state change, so the event exists if and only if the
 * change committed, then let a worker deliver it. Delivery becomes at-least-once
 * instead of at-most-once, which is the right direction for a notification —
 * receivers dedupe on `trackingId`.
 */

import { createHmac } from 'crypto';
import { decryptSecret, isEncryptedSecret } from '../../shared/secrets';
import { Prisma } from '@prisma/client';
import { prisma } from '../ledger/ledger.service';

const TICK_MS = Number(process.env.OUTBOX_WORKER_INTERVAL_MS ?? 10_000);
const BATCH = Number(process.env.OUTBOX_WORKER_BATCH ?? 25);
const DELIVERY_TIMEOUT_MS = Number(process.env.OUTBOX_DELIVERY_TIMEOUT_MS ?? 10_000);

// ── Enqueue ───────────────────────────────────────────────────────────────────

export interface OutboxEnqueue {
  channel: 'bank.webhook' | 'internal.event' | 'institution.webhook';
  eventType: string;
  targetUrl?: string | null;
  targetSecret?: string | null;
  payload: Prisma.InputJsonValue;
  entityType?: string;
  entityId?: string;
  maxAttempts?: number;
}

/**
 * MUST be called with the transaction that made the state change. Taking `tx`
 * rather than defaulting to the global client is the whole point — an event
 * enqueued outside the transaction can be delivered for a change that rolled
 * back, or lost for one that committed.
 */
export async function enqueue(tx: Prisma.TransactionClient, event: OutboxEnqueue): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      channel: event.channel,
      eventType: event.eventType,
      targetUrl: event.targetUrl ?? null,
      // Resolved at write time so a later config change cannot silently
      // redirect an event that has already been committed.
      targetSecret: event.targetSecret ?? null,
      payload: event.payload,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      maxAttempts: event.maxAttempts ?? 8,
    },
  });
}

// ── Delivery ──────────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 over the exact bytes sent, so the receiver verifies what it
 * actually got rather than a re-serialisation of it.
 */
export function sign(secret: string, body: string, timestamp: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function deliverOne(event: {
  id: string;
  targetUrl: string | null;
  targetSecret: string | null;
  payload: Prisma.JsonValue;
  eventType: string;
  attempts: number;
  maxAttempts: number;
  channel?: string;
}): Promise<void> {
  if (!event.targetUrl) {
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: 'ABANDONED', lastError: 'no target URL' },
    });
    return;
  }

  const body = JSON.stringify(event.payload);
  const institution = event.channel === 'institution.webhook';
  // Institution webhooks (Step 2): documented format — unix seconds, `t=…,v1=…`, event id header —
  // and the secret is stored encrypted, decrypted only here, never logged.
  const timestamp = institution ? Math.floor(Date.now() / 1000).toString() : Date.now().toString();
  const secret = event.targetSecret ? (isEncryptedSecret(event.targetSecret) ? decryptSecret(event.targetSecret) : event.targetSecret) : null;
  const payloadId = institution ? (event.payload as { id?: string } | null)?.id ?? event.id : event.id;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const res = await fetch(event.targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-axlink-event': event.eventType,
        'x-axlink-timestamp': timestamp,
        'x-axlink-delivery': event.id,
        ...(institution ? { 'x-axlink-event-id': payloadId } : {}),
        ...(secret ? { 'x-axlink-signature': institution ? `t=${timestamp},v1=${sign(secret, body, timestamp)}` : sign(secret, body, timestamp) } : {}),
      },
      body,
      signal: controller.signal,
    });

    if (res.ok) {
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'DELIVERED', deliveredAt: new Date(), lastStatus: res.status, attempts: { increment: 1 } },
      });
      return;
    }

    // A 4xx other than 408/429 will fail identically forever — stop early
    // rather than burning eight attempts on a permanently malformed target.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    await fail(event, `HTTP ${res.status}`, res.status, permanent);
  } catch (err) {
    await fail(event, err instanceof Error ? err.message : String(err), null, false);
  } finally {
    clearTimeout(timer);
  }
}

async function fail(
  event: { id: string; attempts: number; maxAttempts: number; channel?: string },
  message: string,
  status: number | null,
  permanent: boolean,
): Promise<void> {
  const attempts = event.attempts + 1;
  const exhausted = permanent || attempts >= event.maxAttempts;

  await prisma.outboxEvent.update({
    where: { id: event.id },
    data: {
      status: exhausted ? 'FAILED' : 'PENDING',
      attempts,
      lastError: message.slice(0, 1000),
      lastStatus: status,
      nextAttemptAt: exhausted ? new Date() : new Date(Date.now() + (event.channel === 'institution.webhook' ? institutionRetryMs(attempts) : backoffMs(attempts))),
    },
  });

  if (exhausted) {
    console.error(`[outbox] event ${event.id} abandoned after ${attempts} attempt(s): ${message}`);
  }
}

/** Institution webhooks: the documented schedule — 1 m, 5 m, 30 m, 2 h, 12 h after the first failure. */
export const INSTITUTION_RETRY_SCHEDULE_S = [60, 300, 1800, 7200, 43200] as const;
export function institutionRetryMs(attempt: number): number {
  return (INSTITUTION_RETRY_SCHEDULE_S[Math.min(attempt, INSTITUTION_RETRY_SCHEDULE_S.length) - 1] ?? 43200) * 1000;
}

/** Exponential to a 30-minute ceiling, jittered so retries do not synchronise. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(30 * 60_000, 5_000 * 2 ** (attempt - 1));
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

// ── Worker ────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function drain(limit = BATCH): Promise<{ delivered: number; failed: number }> {
  const due = await prisma.outboxEvent.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let delivered = 0;
  let failed = 0;

  for (const event of due) {
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'DELIVERING' } });
    await deliverOne(event);
    const after = await prisma.outboxEvent.findUnique({ where: { id: event.id }, select: { status: true } });
    if (after?.status === 'DELIVERED') delivered += 1;
    else failed += 1;
  }

  return { delivered, failed };
}

export function startOutboxWorker(): void {
  if (timer) return;
  console.log(`[outbox] worker started — every ${TICK_MS}ms, batch ${BATCH}`);

  timer = setInterval(() => {
    if (running) return;
    running = true;
    drain()
      .then(r => {
        if (r.delivered || r.failed) console.log(`[outbox] delivered ${r.delivered}, failed ${r.failed}`);
      })
      .catch(err => console.error('[outbox] drain failed:', err))
      .finally(() => {
        running = false;
      });
  }, TICK_MS);

  timer.unref?.();
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function outboxStatus() {
  const byStatus = await prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } });
  const failed = await prisma.outboxEvent.findMany({
    where: { status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, eventType: true, targetUrl: true, attempts: true, lastError: true, lastStatus: true, entityId: true },
  });

  return {
    running: timer !== null,
    counts: Object.fromEntries(byStatus.map(g => [g.status, g._count._all])),
    failed,
  };
}

/** Ops: put a failed event back in the queue after fixing the target. */
export async function replay(eventId: string): Promise<void> {
  await prisma.outboxEvent.update({
    where: { id: eventId },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
}
