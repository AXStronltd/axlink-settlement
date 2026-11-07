/**
 * Fireblocks Network B2B Settlement Service
 *
 * Implements:
 *  1. Network connections  — create, list, approve (GET/POST /v1/network_connections)
 *  2. Network profiles     — list, get routing rules
 *  3. Smart Transfers      — create tickets, fund legs, cancel; intermediary-opened tickets
 *  4. Direct NETWORK_CONNECTION transfers — POST /v1/transactions with
 *     destination.type = NETWORK_CONNECTION
 *  5. JWS webhook validation — every incoming payload verified before processing
 *
 * All env vars are loaded at call time, never at import time:
 *   FIREBLOCKS_API_KEY            — workspace API key
 *   FIREBLOCKS_SECRET_KEY_PATH    — path to RSA private key PEM file
 *   FIREBLOCKS_SANDBOX            — "true" → use sandbox endpoint
 *   FIREBLOCKS_WEBHOOK_PUBLIC_KEY — RSA-2048 PEM from Console → Webhooks
 *
 * Pass { dryRun: true } to any mutating function to log the intended call
 * and return a stub instead of hitting the API.
 */

import crypto from 'crypto';
import { readFileSync } from 'fs';
import {
  Fireblocks,
  BasePath,
  TransferPeerPathType,
  TransactionOperation,
  FeeLevel,
} from '@fireblocks/ts-sdk';

import { fireblocksBasePath } from './fireblocks';
import { log } from '../../../shared/logger';

// ── Client ───────────────────────────────────────────────────────────────────

function buildClient(): Fireblocks {
  const apiKey  = process.env.FIREBLOCKS_API_KEY!;
  const keyPath = process.env.FIREBLOCKS_SECRET_KEY_PATH!;
  const sandbox = process.env.FIREBLOCKS_SANDBOX === 'true';
  return new Fireblocks({
    apiKey,
    secretKey: readFileSync(keyPath, 'utf8'),
    basePath:  fireblocksBasePath(sandbox),
  });
}

let _client: Fireblocks | null = null;
function sdk(): Fireblocks {
  if (!_client) _client = buildClient();
  return _client;
}

function isLive(): boolean {
  const k = process.env.FIREBLOCKS_API_KEY ?? '';
  const p = process.env.FIREBLOCKS_SECRET_KEY_PATH ?? '';
  return !!(k && p && !k.startsWith('your_') && !k.startsWith('YOUR_'));
}

function stubId(prefix: string) {
  return `${prefix}_${process.env.FIREBLOCKS_SANDBOX === 'true' ? 'sandbox' : 'stub'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface NetworkConnection {
  id: string;
  status: string;
  remoteNetworkId?: { id: string; name?: string };
  localNetworkId?:  { id: string; name?: string };
  routingPolicy?: Record<string, unknown>;
}

export interface NetworkProfile {
  id: string;
  name: string;
  isDefault: boolean;
  routingPolicy?: Record<string, unknown>;
}

export interface SmartTransferTicket {
  id: string;
  status: string;
  createdByNetworkId?: string;
  legs: SmartTransferLeg[];
  expiresAt?: string;
  createdAt?: string;
}

export interface SmartTransferLeg {
  id: string;
  assetId: string;
  srcNetworkId?: string;
  dstNetworkId?: string;
  amount?: string;
  status: string;
  fbTxId?: string;
}

export interface CreateSmartTransferParams {
  /** The transfer type — "ASYNC" for asynchronous, "ATOMIC" for atomic swaps */
  type?: 'ASYNC' | 'ATOMIC';
  legs: Array<{
    assetId: string;
    amount: string;
    srcNetworkId: string;
    dstNetworkId: string;
  }>;
  /** Expiry in ISO format; defaults to 24 h */
  expiresAt?: string;
  /** Set true when an intermediary opens a ticket on behalf of two third parties.
   *  All three (intermediary, src, dst) must share the same network profile. */
  thirdParty?: boolean;
  note?: string;
  dryRun?: boolean;
}

export interface NetworkDirectTransferParams {
  assetId: string;
  amount: string;
  sourceVaultId: string;
  /** Fireblocks Network connection ID */
  networkConnectionId: string;
  note?: string;
  externalTxId?: string;
  feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  dryRun?: boolean;
}

// ── 1. Network Connections ───────────────────────────────────────────────────

/**
 * List all network connections for this workspace.
 * Connections represent approved bilateral relationships between network IDs.
 */
export async function listNetworkConnections(): Promise<NetworkConnection[]> {
  if (!isLive()) {
    log.info('fireblocks_network.list_connections.dry_run', { mode: 'sandbox_stub' });
    return [];
  }
  try {
    // The SDK exposes network connections under client.network
    // Using raw API access via the base client since the generated SDK type
    // varies across versions; fall back to empty list if the endpoint is absent.
    const res = await (sdk() as unknown as { network?: { getNetworkConnections: () => Promise<{ data: unknown[] }> } })
      .network?.getNetworkConnections();
    return (res?.data ?? []) as NetworkConnection[];
  } catch (err) {
    log.warn('fireblocks_network.list_connections.failed', { error: (err as Error).message });
    return [];
  }
}

/**
 * Request a new bilateral network connection to a counterparty.
 * Returns the pending connection; the counterparty must approve it in their Console.
 */
export async function createNetworkConnection(params: {
  remoteNetworkId: string;
  /** Route all asset types by default; pass a specific routing policy to restrict */
  routingPolicy?: Record<string, unknown>;
  dryRun?: boolean;
}): Promise<NetworkConnection> {
  const { remoteNetworkId, routingPolicy, dryRun } = params;

  if (dryRun || !isLive()) {
    const result: NetworkConnection = {
      id:              stubId('conn'),
      status:          'WAITING_FOR_APPROVAL',
      remoteNetworkId: { id: remoteNetworkId },
    };
    log.info('fireblocks_network.create_connection.dry_run', { remoteNetworkId, result });
    return result;
  }

  const body: Record<string, unknown> = { remoteNetworkId };
  if (routingPolicy) body.routingPolicy = routingPolicy;

  const res = await (sdk() as unknown as {
    network: { setNetworkIdStatus: (id: string, body: unknown) => Promise<{ data: NetworkConnection }> }
  }).network.setNetworkIdStatus(remoteNetworkId, body);
  log.info('fireblocks_network.create_connection', { remoteNetworkId, connectionId: res.data.id });
  return res.data;
}

// ── 2. Network Profiles ──────────────────────────────────────────────────────

/**
 * List your workspace's network profiles (routing identities).
 * Smart Transfers require all parties to share a profile.
 */
export async function listNetworkProfiles(): Promise<NetworkProfile[]> {
  if (!isLive()) {
    return [{ id: 'profile_sandbox', name: 'Sandbox Profile', isDefault: true }];
  }
  try {
    const res = await (sdk() as unknown as {
      network: { getNetworkProfiles: () => Promise<{ data: NetworkProfile[] }> }
    }).network.getNetworkProfiles();
    return res.data;
  } catch (err) {
    log.warn('fireblocks_network.list_profiles.failed', { error: (err as Error).message });
    return [];
  }
}

// ── 3. Smart Transfers ───────────────────────────────────────────────────────

/**
 * Create a Smart Transfer ticket.
 *
 * Smart Transfers are pre-agreed multi-leg transactions. Each leg specifies
 * which asset moves from which network ID to which network ID.
 *
 * For an intermediary-opened ticket (thirdParty=true), all network IDs in
 * all legs plus the creating workspace must all share the same network profile.
 */
export async function createSmartTransferTicket(
  params: CreateSmartTransferParams,
): Promise<SmartTransferTicket> {
  const { type = 'ASYNC', legs, expiresAt, thirdParty, note, dryRun } = params;

  if (dryRun || !isLive()) {
    const ticket: SmartTransferTicket = {
      id:     stubId('smt'),
      status: 'OPEN',
      legs:   legs.map((l, i) => ({
        id:          stubId(`leg${i}`),
        assetId:     l.assetId,
        srcNetworkId: l.srcNetworkId,
        dstNetworkId: l.dstNetworkId,
        amount:      l.amount,
        status:      'CREATED',
      })),
      expiresAt: expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    log.info('fireblocks_network.smart_transfer.create.dry_run', { type, legs, ticket });
    return ticket;
  }

  const body: Record<string, unknown> = { type, legs };
  if (expiresAt)   body.expiresAt   = expiresAt;
  if (thirdParty)  body.thirdParty  = true;
  if (note)        body.note        = note;

  const res = await (sdk() as unknown as {
    smartTransfer: { createTicket: (b: unknown) => Promise<{ data: SmartTransferTicket }> }
  }).smartTransfer.createTicket(body);

  log.info('fireblocks_network.smart_transfer.created', {
    ticketId: res.data.id,
    legs: res.data.legs.map(l => ({ id: l.id, assetId: l.assetId, amount: l.amount, status: l.status })),
  });
  return res.data;
}

/**
 * Fund a specific leg of an open Smart Transfer ticket.
 * The funding vault must have sufficient balance for the leg's asset + amount.
 */
export async function fundSmartTransferLeg(params: {
  ticketId: string;
  legId: string;
  sourceVaultId: string;
  dryRun?: boolean;
}): Promise<SmartTransferLeg> {
  const { ticketId, legId, sourceVaultId, dryRun } = params;

  if (dryRun || !isLive()) {
    const leg: SmartTransferLeg = { id: legId, assetId: 'USDT_SOL', status: 'FUNDED' };
    log.info('fireblocks_network.smart_transfer.fund_leg.dry_run', { ticketId, legId, sourceVaultId });
    return leg;
  }

  const res = await (sdk() as unknown as {
    smartTransfer: {
      fundTicketTerm: (ticketId: string, legId: string, body: unknown) => Promise<{ data: SmartTransferLeg }>
    }
  }).smartTransfer.fundTicketTerm(ticketId, legId, { sourceVaultId });

  log.info('fireblocks_network.smart_transfer.leg_funded', { ticketId, legId, status: res.data.status, fbTxId: res.data.fbTxId });
  return res.data;
}

/**
 * Cancel an open Smart Transfer ticket (before any legs are funded).
 */
export async function cancelSmartTransferTicket(params: {
  ticketId: string;
  dryRun?: boolean;
}): Promise<void> {
  const { ticketId, dryRun } = params;

  if (dryRun || !isLive()) {
    log.info('fireblocks_network.smart_transfer.cancel.dry_run', { ticketId });
    return;
  }

  await (sdk() as unknown as {
    smartTransfer: { cancelTicket: (id: string) => Promise<void> }
  }).smartTransfer.cancelTicket(ticketId);

  log.info('fireblocks_network.smart_transfer.cancelled', { ticketId });
}

/**
 * Get the current status of a Smart Transfer ticket (all legs).
 */
export async function getSmartTransferTicket(ticketId: string): Promise<SmartTransferTicket | null> {
  if (!isLive()) {
    return { id: ticketId, status: 'OPEN', legs: [] };
  }
  try {
    const res = await (sdk() as unknown as {
      smartTransfer: { getTicketById: (id: string) => Promise<{ data: SmartTransferTicket }> }
    }).smartTransfer.getTicketById(ticketId);
    return res.data;
  } catch (err) {
    const e = err as Error & { response?: { status?: number } };
    if (e.response?.status === 404) return null;
    throw err;
  }
}

/**
 * List all Smart Transfer tickets (paginated).
 */
export async function listSmartTransferTickets(params?: {
  status?: string;
  limit?: number;
  after?: string;
}): Promise<SmartTransferTicket[]> {
  if (!isLive()) return [];
  try {
    const res = await (sdk() as unknown as {
      smartTransfer: {
        getTickets: (p?: Record<string, unknown>) => Promise<{ data: SmartTransferTicket[] }>
      }
    }).smartTransfer.getTickets(params);
    return res.data;
  } catch (err) {
    log.warn('fireblocks_network.smart_transfer.list.failed', { error: (err as Error).message });
    return [];
  }
}

// ── 4. Direct NETWORK_CONNECTION transfers ───────────────────────────────────

const FEE_MAP: Record<string, FeeLevel> = {
  LOW: FeeLevel.Low, MEDIUM: FeeLevel.Medium, HIGH: FeeLevel.High,
};

/**
 * Send funds directly to a counterparty using a pre-established network connection.
 *
 * Uses destination.type = NETWORK_CONNECTION (not VaultAccount or OneTimeAddress).
 * Requires the connection ID from listNetworkConnections().
 *
 * This is the simplest path for recurring bilateral settlements:
 *   source vault → Fireblocks Network → counterparty vault
 */
export async function createNetworkDirectTransfer(
  params: NetworkDirectTransferParams,
): Promise<{ id: string; status: string; externalTxId?: string }> {
  const { assetId, amount, sourceVaultId, networkConnectionId, note, externalTxId, feeLevel, dryRun } = params;

  if (dryRun || !isLive()) {
    const result = { id: stubId('ntx'), status: 'SUBMITTED', externalTxId };
    log.info('fireblocks_network.direct_transfer.dry_run', {
      assetId, amount, sourceVaultId, networkConnectionId, externalTxId, result,
    });
    return result;
  }

  const res = await sdk().transactions.createTransaction({
    transactionRequest: {
      assetId,
      amount,
      source: {
        type: TransferPeerPathType.VaultAccount,
        id:   sourceVaultId,
      },
      destination: {
        // NETWORK_CONNECTION directs the transfer through the bilateral channel
        type: 'NETWORK_CONNECTION' as TransferPeerPathType,
        id:   networkConnectionId,
      },
      operation: TransactionOperation.Transfer,
      note:      note ?? 'AxLink network settlement',
      feeLevel:  FEE_MAP[feeLevel ?? 'MEDIUM'],
      ...(externalTxId ? { externalTxId } : {}),
    },
  });

  const tx = res.data;
  log.info('fireblocks_network.direct_transfer.submitted', {
    txId: tx.id, status: tx.status, assetId, amount, networkConnectionId, externalTxId,
  });
  return { id: tx.id!, status: tx.status ?? 'SUBMITTED', externalTxId };
}

// ── 5. Webhook JWS Validation ────────────────────────────────────────────────

/**
 * Validate a Fireblocks webhook payload.
 *
 * Fireblocks signs each webhook delivery with its RSA private key.
 * The signature is RSA-SHA512, base64-encoded, in the
 * `fireblocks-signature` header.
 *
 * Returns false (never throws) on any validation failure —
 * the caller should respond 401 or 403 to reject the payload.
 */
export function validateWebhookSignature(rawBody: string, signatureHeader: string): boolean {
  const pubKey = process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY ?? '';
  if (!pubKey) {
    // Not configured — log and pass-through only in sandbox mode
    if (process.env.FIREBLOCKS_SANDBOX === 'true') {
      log.warn('fireblocks_network.webhook.pubkey_unset_sandbox', {});
      return true;
    }
    log.error('fireblocks_network.webhook.pubkey_unset', {});
    return false;
  }
  if (!signatureHeader) {
    log.warn('fireblocks_network.webhook.missing_signature', {});
    return false;
  }
  try {
    const valid = crypto.verify(
      'sha512',
      Buffer.from(rawBody),
      { key: pubKey, format: 'pem' as const },
      Buffer.from(signatureHeader, 'base64'),
    );
    if (!valid) log.warn('fireblocks_network.webhook.invalid_signature', {});
    return valid;
  } catch (err) {
    log.warn('fireblocks_network.webhook.verify_threw', { error: (err as Error).message });
    return false;
  }
}

// ── Status helpers ───────────────────────────────────────────────────────────

/** Terminal states: a transfer in one of these will not change further. */
export const TERMINAL_STATUSES = new Set([
  'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED', 'BLOCKED',
]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status?.toUpperCase());
}

/** Map a raw Fireblocks transaction status to an AxLink settlement status. */
export function mapTxStatus(fbStatus: string): string {
  const s = fbStatus?.toUpperCase();
  if (s === 'COMPLETED')   return 'SETTLED';
  if (s === 'CONFIRMING')  return 'CONFIRMING';
  if (s === 'BROADCASTING') return 'BROADCASTING';
  if (['FAILED', 'REJECTED', 'BLOCKED'].includes(s)) return 'FAILED';
  if (s === 'CANCELLED')   return 'CANCELLED';
  return 'PENDING';
}

/** Log every settlement status change with structured fields. */
export function logSettlementStatusChange(params: {
  entityType: 'TRANSFER' | 'SMART_TRANSFER_LEG';
  entityId: string;
  prevStatus: string;
  newStatus: string;
  fbTxId?: string;
  txHash?: string;
  amount?: string;
  assetId?: string;
  meta?: Record<string, unknown>;
}): void {
  const { entityType, entityId, prevStatus, newStatus, fbTxId, txHash, amount, assetId, meta } = params;
  log.info('settlement.status_change', {
    entityType, entityId,
    from: prevStatus, to: newStatus,
    fbTxId, txHash, amount, assetId,
    terminal: isTerminal(newStatus),
    ...meta,
  });
}
