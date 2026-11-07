/**
 * AxLink Webhook Signature Verification
 *
 * Every webhook delivery from AxLink carries:
 *   X-AxLink-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
 *
 * The signature covers: `${timestamp}.${rawBody}`
 * signed with the secret returned when you registered the endpoint.
 *
 * @example Node.js (Express)
 * ```ts
 * import express from 'express';
 * import { verifyAxLinkWebhook, AxLinkWebhookVerificationError } from '@axlink/sdk';
 *
 * app.post('/webhooks/axlink', express.raw({ type: 'application/json' }), (req, res) => {
 *   try {
 *     const event = verifyAxLinkWebhook({
 *       body: req.body,            // Buffer or string — raw, unmodified
 *       signature: req.headers['x-axlink-signature'] as string,
 *       secret: process.env.AXLINK_WEBHOOK_SECRET!,
 *       toleranceSeconds: 300,     // reject events older than 5 min (default)
 *     });
 *     // event is typed and verified
 *     console.log(event.type, event.data);
 *     res.sendStatus(200);
 *   } catch (err) {
 *     if (err instanceof AxLinkWebhookVerificationError) {
 *       res.status(400).json({ error: err.code });
 *     } else {
 *       res.sendStatus(500);
 *     }
 *   }
 * });
 * ```
 */

import { createHmac, timingSafeEqual } from 'crypto';

// ── Webhook event shapes ───────────────────────────────────────────────────────

export type WebhookEventType =
  | 'deposit.received'
  | 'deposit.settled'
  | 'deposit.rejected'
  | 'deposit.expired'
  | 'transfer.submitted'
  | 'transfer.settled'
  | 'transfer.failed'
  | 'settlement.received';

/** Envelope of every delivery (exactly what the API signs and sends). */
export interface WebhookEventBase<T extends WebhookEventType, D> {
  /** Event id (evt_…): the same id is redelivered on retry, so dedupe on it. */
  id: string;
  type: T;
  createdAt: string;
  data: D;
}

type AssetId = 'USDC_SOL' | 'USDT_SOL';
type PublicStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

/** deposit.* — `settlementId` is the deposit instruction id (GET /v1/settlements/:id or /v1/deposits/:id). */
export interface DepositEventData {
  settlementId: string;
  kind: 'DEPOSIT';
  status: PublicStatus;
  walletId: string;
  asset: AssetId;
  /** Received amount (deposit.received / deposit.settled). */
  amount?: string;
  /** Announced amount (deposit.rejected / deposit.expired). */
  expectedAmount?: string;
  reference: string | null;
  trackingId: string;
  finality?: 'CUSTODY_CONFIRMED' | 'ON_CHAIN_FINALIZED';
  txHash?: string | null;
  explorerUrl?: string | null;
  slot?: string | null;
  custodyTxId?: string | null;
  attention?: true;
  reason?: string;
}

/** transfer.* — an outbound transfer or network settlement you initiated. */
export interface TransferEventData {
  transferId: string;
  kind: 'TRANSFER';
  status: PublicStatus;
  stage: string;
  walletId: string;
  counterpartyId: string;
  asset: AssetId;
  amount: string;
  reference: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  attention?: true;
  reason?: string;
  providerTxId?: string;
}

/** settlement.received — another institution settled to you on the network (credited at finality). */
export interface SettlementEventData {
  transferId: string;
  kind: 'NETWORK_SETTLEMENT';
  status: 'COMPLETED';
  walletId: string;
  asset: AssetId;
  amount: string;
  reference: string | null;
  from: { participant: string | null; name: string | null };
  finality: string;
  txHash: string | null;
}

export type DepositReceivedEvent  = WebhookEventBase<'deposit.received',   DepositEventData>;
export type DepositSettledEvent   = WebhookEventBase<'deposit.settled',    DepositEventData>;
export type DepositRejectedEvent  = WebhookEventBase<'deposit.rejected',   DepositEventData>;
export type DepositExpiredEvent   = WebhookEventBase<'deposit.expired',    DepositEventData>;
export type TransferSubmittedEvent = WebhookEventBase<'transfer.submitted', TransferEventData>;
export type TransferSettledEvent  = WebhookEventBase<'transfer.settled',   TransferEventData>;
export type TransferFailedEvent   = WebhookEventBase<'transfer.failed',    TransferEventData>;
export type SettlementReceivedEvent = WebhookEventBase<'settlement.received', SettlementEventData>;

export type AxLinkWebhookEvent =
  | DepositReceivedEvent
  | DepositSettledEvent
  | DepositRejectedEvent
  | DepositExpiredEvent
  | TransferSubmittedEvent
  | TransferSettledEvent
  | TransferFailedEvent
  | SettlementReceivedEvent;

// ── Error ─────────────────────────────────────────────────────────────────────

export type WebhookVerificationErrorCode =
  | 'MISSING_SIGNATURE'
  | 'MALFORMED_SIGNATURE'
  | 'TIMESTAMP_TOO_OLD'
  | 'TIMESTAMP_IN_FUTURE'
  | 'SIGNATURE_MISMATCH'
  | 'INVALID_JSON';

export class AxLinkWebhookVerificationError extends Error {
  constructor(public readonly code: WebhookVerificationErrorCode, message: string) {
    super(`AxLink webhook [${code}]: ${message}`);
    this.name = 'AxLinkWebhookVerificationError';
  }
}

// ── Verification ──────────────────────────────────────────────────────────────

export interface VerifyAxLinkWebhookOptions {
  /** Raw request body — Buffer or string; must be unmodified (not JSON.parse'd and re-stringified) */
  body: Buffer | string;
  /** Value of the X-AxLink-Signature header */
  signature: string;
  /** The signing secret returned when you created the webhook endpoint */
  secret: string;
  /** Maximum age of the event in seconds (default: 300 / 5 minutes) */
  toleranceSeconds?: number;
}

/**
 * Verify an AxLink webhook signature and parse the event.
 *
 * Throws `AxLinkWebhookVerificationError` if:
 * - The signature header is missing or malformed
 * - The timestamp is outside the tolerance window
 * - The HMAC digest does not match
 * - The body is not valid JSON
 *
 * Returns the typed `AxLinkWebhookEvent` on success.
 */
export function verifyAxLinkWebhook(opts: VerifyAxLinkWebhookOptions): AxLinkWebhookEvent {
  const { body, signature, secret, toleranceSeconds = 300 } = opts;

  if (!signature) {
    throw new AxLinkWebhookVerificationError('MISSING_SIGNATURE', 'X-AxLink-Signature header is absent');
  }

  // Parse "t=<unix>,v1=<hex>"
  const parts: Record<string, string> = {};
  for (const chunk of signature.split(',')) {
    const eq = chunk.indexOf('=');
    if (eq > 0) parts[chunk.slice(0, eq)] = chunk.slice(eq + 1);
  }

  if (!parts['t'] || !parts['v1']) {
    throw new AxLinkWebhookVerificationError('MALFORMED_SIGNATURE', 'Expected t=<unix>,v1=<hex>');
  }

  const timestamp = parseInt(parts['t']!, 10);
  if (isNaN(timestamp)) {
    throw new AxLinkWebhookVerificationError('MALFORMED_SIGNATURE', 'Timestamp is not a number');
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > toleranceSeconds) {
    throw new AxLinkWebhookVerificationError('TIMESTAMP_TOO_OLD', `Event timestamp ${timestamp} is more than ${toleranceSeconds}s old`);
  }
  if (timestamp - now > 60) {
    throw new AxLinkWebhookVerificationError('TIMESTAMP_IN_FUTURE', `Event timestamp ${timestamp} is more than 60s in the future`);
  }

  // Compute expected HMAC
  const rawBody = typeof body === 'string' ? body : body.toString('utf8');
  const payload = `${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');

  // Constant-time comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(parts['v1']!, 'hex');

  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    throw new AxLinkWebhookVerificationError('SIGNATURE_MISMATCH', 'HMAC digest does not match');
  }

  // Parse and return
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new AxLinkWebhookVerificationError('INVALID_JSON', 'Body is not valid JSON');
  }

  return event as AxLinkWebhookEvent;
}
