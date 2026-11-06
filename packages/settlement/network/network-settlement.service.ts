/**
 * Fireblocks Network B2B Settlement Service — business logic layer.
 *
 * Wraps fireblocks-network.ts (raw API adapter) with:
 *  - Idempotency (externalTxId guard)
 *  - Settlement leg journalling
 *  - Status tracking and status-change logging
 *  - Counterparty registry (NetworkConnection ↔ Institution)
 *  - Webhook event dispatch
 */

import { prisma } from '../../core/ledger/ledger.service';
import { log }    from '../../shared/logger';
import {
  createNetworkDirectTransfer,
  createSmartTransferTicket,
  fundSmartTransferLeg,
  cancelSmartTransferTicket,
  getSmartTransferTicket,
  listNetworkConnections,
  createNetworkConnection,
  listNetworkProfiles,
  listSmartTransferTickets,
  validateWebhookSignature,
  mapTxStatus,
  logSettlementStatusChange,
  type CreateSmartTransferParams,
  type NetworkDirectTransferParams,
} from '../../providers/custody/fireblocks/fireblocks-network';

// ── Counterparty connection registry ─────────────────────────────────────────

/**
 * List all Fireblocks Network connections and overlay Institution metadata.
 * Result is enriched with institution name/networkId where available.
 */
export async function listConnections() {
  const [fbConns, institutions] = await Promise.all([
    listNetworkConnections(),
    prisma.bank.findMany({ select: { id: true, name: true, networkId: true, fbNetworkConnId: true } }).catch(() => []),
  ]);

  // Index institutions by their Fireblocks connection ID
  const instByConn = new Map(
    (institutions as Array<{ id: string; name: string; networkId: string; fbNetworkConnId: string | null }>)
      .filter(i => i.fbNetworkConnId)
      .map(i => [i.fbNetworkConnId!, i]),
  );

  return fbConns.map(c => ({
    connectionId:  c.id,
    status:        c.status,
    remoteNetwork: c.remoteNetworkId,
    localNetwork:  c.localNetworkId,
    institution:   instByConn.get(c.id) ?? null,
    routingPolicy: c.routingPolicy,
  }));
}

/**
 * Request a new bilateral network connection.
 * Records the connection ID on the Institution record once approved.
 */
export async function requestConnection(params: {
  remoteNetworkId: string;
  institutionId?: string;
  dryRun?: boolean;
}) {
  const conn = await createNetworkConnection({
    remoteNetworkId: params.remoteNetworkId,
    dryRun: params.dryRun,
  });

  // If we know which institution this connection is for, persist the mapping
  if (params.institutionId && conn.id && !params.dryRun) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma.bank as any).updateMany({
      where: { id: params.institutionId },
      data:  { fbNetworkConnId: conn.id },
    }).catch((err: Error) => log.warn('network_settlement.persist_conn_id.failed', { error: err.message }));
  }

  return conn;
}

export { listNetworkProfiles };

// ── Direct NETWORK_CONNECTION settlement ─────────────────────────────────────

export interface DirectSettlementParams extends Omit<NetworkDirectTransferParams, 'externalTxId'> {
  settlementId: string;
  idempotencyKey?: string;
}

/**
 * Initiate a direct B2B settlement via an established Fireblocks Network connection.
 * Uses the settlementId as the externalTxId for idempotency/recovery.
 */
export async function initiateDirectSettlement(params: DirectSettlementParams) {
  const { settlementId, dryRun, idempotencyKey, ...rest } = params;
  const externalTxId = idempotencyKey ?? `axlink_${settlementId}`;

  log.info('network_settlement.direct.initiating', {
    settlementId, assetId: rest.assetId, amount: rest.amount,
    networkConnectionId: rest.networkConnectionId, dryRun,
  });

  const tx = await createNetworkDirectTransfer({ ...rest, externalTxId, dryRun });

  logSettlementStatusChange({
    entityType: 'TRANSFER',
    entityId:   settlementId,
    prevStatus: 'INITIATED',
    newStatus:  'SUBMITTED',
    fbTxId:     tx.id,
    amount:     rest.amount,
    assetId:    rest.assetId,
    meta:       { networkConnectionId: rest.networkConnectionId, dryRun },
  });

  return { ...tx, externalTxId };
}

// ── Smart Transfers ───────────────────────────────────────────────────────────

export { listSmartTransferTickets, getSmartTransferTicket };

/**
 * Create a Smart Transfer ticket (async or atomic).
 *
 * For intermediary-opened tickets (thirdParty=true) the creating workspace,
 * the source, and the destination network IDs must all share the same
 * Fireblocks Network profile.
 */
export async function openSmartTransfer(params: CreateSmartTransferParams & { settlementId?: string }) {
  const { settlementId, ...rest } = params;

  log.info('network_settlement.smart_transfer.opening', {
    type: rest.type ?? 'ASYNC',
    legs: rest.legs,
    thirdParty: rest.thirdParty ?? false,
    settlementId,
    dryRun: rest.dryRun,
  });

  const ticket = await createSmartTransferTicket(rest);

  if (settlementId) {
    logSettlementStatusChange({
      entityType: 'TRANSFER',
      entityId:   settlementId,
      prevStatus: 'PENDING',
      newStatus:  'SMART_TRANSFER_OPEN',
      meta:       { ticketId: ticket.id, legs: ticket.legs.length, dryRun: rest.dryRun },
    });
  }

  return ticket;
}

export async function fundTicketLeg(params: {
  ticketId: string;
  legId: string;
  sourceVaultId: string;
  settlementId?: string;
  dryRun?: boolean;
}) {
  const leg = await fundSmartTransferLeg(params);

  if (params.settlementId) {
    logSettlementStatusChange({
      entityType: 'SMART_TRANSFER_LEG',
      entityId:   params.legId,
      prevStatus: 'CREATED',
      newStatus:  leg.status ?? 'FUNDED',
      fbTxId:     leg.fbTxId,
      assetId:    leg.assetId,
      amount:     leg.amount,
      meta:       { ticketId: params.ticketId, settlementId: params.settlementId, dryRun: params.dryRun },
    });
  }

  return leg;
}

export async function cancelTicket(params: {
  ticketId: string;
  settlementId?: string;
  dryRun?: boolean;
}) {
  await cancelSmartTransferTicket(params);

  if (params.settlementId) {
    logSettlementStatusChange({
      entityType: 'TRANSFER',
      entityId:   params.settlementId,
      prevStatus: 'SMART_TRANSFER_OPEN',
      newStatus:  'CANCELLED',
      meta:       { ticketId: params.ticketId, dryRun: params.dryRun },
    });
  }
}

// ── Webhook handling ──────────────────────────────────────────────────────────

export type WebhookResult =
  | { handled: true;  event: string; entityId?: string; newStatus?: string }
  | { handled: false; reason: string };

/**
 * Validate and dispatch a Fireblocks webhook event.
 *
 * Always call this before trusting any webhook payload.
 * Returns { handled: false } for unrecognised event types so callers
 * can respond 200 without side effects.
 */
export async function handleFireblocksWebhook(
  rawBody: string,
  signatureHeader: string,
): Promise<WebhookResult> {
  // Validate JWS signature first — reject before any parsing
  if (!validateWebhookSignature(rawBody, signatureHeader)) {
    return { handled: false, reason: 'invalid_signature' };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { handled: false, reason: 'invalid_json' };
  }

  const type = String(payload.type ?? '');
  const data = (payload.data ?? {}) as Record<string, unknown>;

  log.info('fireblocks_network.webhook.received', { type, id: data.id });

  switch (type) {
    case 'TRANSACTION_STATUS_UPDATED':
      return handleTxStatusUpdate(data);

    case 'TRANSACTION_CREATED':
      return handleTxStatusUpdate(data); // same shape, same handling

    case 'SMART_TRANSFER_TICKET_STATUS_UPDATED':
    case 'SMART_TRANSFER_TICKET_TERM_STATUS_UPDATED':
      return handleSmartTransferUpdate(type, data);

    case 'NETWORK_CONNECTION_STATUS_UPDATED':
      return handleConnectionUpdate(data);

    default:
      log.info('fireblocks_network.webhook.unhandled_type', { type });
      return { handled: false, reason: `unhandled_type:${type}` };
  }
}

// ── Private webhook handlers ──────────────────────────────────────────────────

async function handleTxStatusUpdate(data: Record<string, unknown>): Promise<WebhookResult> {
  const fbTxId     = String(data.id ?? '');
  const fbStatus   = String(data.status ?? '');
  const txHash     = String(data.txHash ?? '');
  const extId      = String(data.externalTxId ?? '');
  const axStatus   = mapTxStatus(fbStatus);

  log.info('fireblocks_network.webhook.tx_status', { fbTxId, fbStatus, axStatus, txHash, extId });

  // Find the leg/transfer linked to this Fireblocks transaction
  if (extId.startsWith('axlink_')) {
    const settlementId = extId.replace(/^axlink_/, '');
    logSettlementStatusChange({
      entityType: 'TRANSFER',
      entityId:   settlementId,
      prevStatus: 'SUBMITTED',
      newStatus:  axStatus,
      fbTxId,
      txHash:     txHash || undefined,
    });

    // Persist on the InterbankTransfer if the row exists
    await prisma.interbankTransfer.updateMany({
      where: { trackingId: settlementId },
      data: {
        fbTxId:       fbTxId || undefined,
        solanaTxHash: txHash || undefined,
        status:       axStatus,
        ...(axStatus === 'SETTLED' ? { settledAt: new Date() } : {}),
      },
    }).catch(err => log.warn('network_settlement.webhook.persist_failed', { error: (err as Error).message }));
  }

  return { handled: true, event: 'TRANSACTION_STATUS_UPDATED', newStatus: axStatus };
}

async function handleSmartTransferUpdate(
  type: string,
  data: Record<string, unknown>,
): Promise<WebhookResult> {
  const ticketId = String(data.id ?? '');
  const status   = String(data.status ?? '');

  log.info('fireblocks_network.webhook.smart_transfer', { type, ticketId, status });

  // If a leg update, also log the leg
  if (type === 'SMART_TRANSFER_TICKET_TERM_STATUS_UPDATED') {
    const legs = Array.isArray(data.legs) ? (data.legs as Array<Record<string, unknown>>) : [];
    for (const leg of legs) {
      logSettlementStatusChange({
        entityType: 'SMART_TRANSFER_LEG',
        entityId:   String(leg.id ?? ticketId),
        prevStatus: 'PENDING',
        newStatus:  String(leg.status ?? status),
        fbTxId:     String(leg.txId ?? ''),
        assetId:    String(leg.assetId ?? ''),
        amount:     String(leg.amount ?? ''),
        meta:       { ticketId },
      });
    }
  }

  return { handled: true, event: type, entityId: ticketId, newStatus: status };
}

async function handleConnectionUpdate(data: Record<string, unknown>): Promise<WebhookResult> {
  const connId = String(data.id ?? '');
  const status = String(data.status ?? '');

  log.info('fireblocks_network.webhook.connection_update', { connId, status });

  // If the connection is now ACTIVE, update the institution record
  if (status === 'APPROVED' || status === 'ACTIVE') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma.bank as any).updateMany({
      where: { fbNetworkConnId: connId },
      data:  { status: 'ACTIVE' },
    }).catch(() => { /* ok if no row matches — fbNetworkConnId may not yet be indexed */ });
  }

  return { handled: true, event: 'NETWORK_CONNECTION_STATUS_UPDATED', entityId: connId, newStatus: status };
}
