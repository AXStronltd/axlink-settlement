/**
 * Fireblocks Network B2B Settlement API Routes
 *
 * All routes under /api/v1/network-settlement
 *
 * Authentication:
 *   - Ops endpoints (/connections, /profiles, /smart-transfers management):
 *       Bearer OPS_API_KEY in Authorization header
 *   - Institution endpoints (/transfers, /tickets/fund):
 *       Bearer institution API key (requireBankAuth)
 *   - /webhooks/fireblocks-network:
 *       No auth — validated by JWS signature on every payload
 *
 * Dry-run mode:
 *   - Set header X-Dry-Run: true or env FIREBLOCKS_SANDBOX=true
 *   - All mutating calls log the intended action and return a stub
 */

import { Router, Request, Response } from 'express';
import { requireOps }                from '../platform/ops-auth';
import { requireBankAuth }           from '../../../../packages/core/auth/auth.middleware';
import {
  listConnections,
  requestConnection,
  listNetworkProfiles,
  listSmartTransferTickets,
  getSmartTransferTicket,
  openSmartTransfer,
  fundTicketLeg,
  cancelTicket,
  initiateDirectSettlement,
  handleFireblocksWebhook,
} from '../../../../packages/providers/custody/fireblocks/network-settlement.service';
import { log } from '../../../../packages/shared/logger';

const router = Router();

function isDryRun(req: Request): boolean {
  return (
    req.headers['x-dry-run'] === 'true' ||
    process.env.FIREBLOCKS_SANDBOX === 'true'
  );
}

// ── Connections (ops) ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/network-settlement/connections
 * List all bilateral Fireblocks Network connections, enriched with institution data.
 */
router.get('/connections', requireOps, async (_req: Request, res: Response): Promise<void> => {
  const connections = await listConnections();
  res.json({ connections, total: connections.length });
});

/**
 * POST /api/v1/network-settlement/connections
 * Request a new bilateral network connection to a counterparty.
 *
 * Body: { remoteNetworkId: string, institutionId?: string }
 *
 * The counterparty must approve the connection in their Fireblocks Console.
 * Status begins as WAITING_FOR_APPROVAL.
 */
router.post('/connections', requireOps, async (req: Request, res: Response): Promise<void> => {
  const { remoteNetworkId, institutionId } = req.body as {
    remoteNetworkId: string;
    institutionId?: string;
  };

  if (!remoteNetworkId) {
    res.status(400).json({ error: 'remoteNetworkId is required', code: 'VALIDATION_ERROR' });
    return;
  }

  const dryRun = isDryRun(req);
  const conn = await requestConnection({ remoteNetworkId, institutionId, dryRun });

  res.status(dryRun ? 200 : 201).json({
    connection: conn,
    dryRun,
    note: dryRun ? 'Dry run — no actual connection created' :
      'Connection requested. Counterparty must approve in their Fireblocks Console.',
  });
});

// ── Network Profiles (ops) ────────────────────────────────────────────────────

/**
 * GET /api/v1/network-settlement/profiles
 * List Fireblocks Network profiles for this workspace.
 * Smart Transfers require all parties to share a profile.
 */
router.get('/profiles', requireOps, async (_req: Request, res: Response): Promise<void> => {
  const profiles = await listNetworkProfiles();
  res.json({ profiles, total: profiles.length });
});

// ── Smart Transfers (ops + institution) ───────────────────────────────────────

/**
 * GET /api/v1/network-settlement/tickets
 * List Smart Transfer tickets (ops only).
 */
router.get('/tickets', requireOps, async (req: Request, res: Response): Promise<void> => {
  const { status, limit, after } = req.query as Record<string, string>;
  const tickets = await listSmartTransferTickets({
    status: status || undefined,
    limit:  limit ? parseInt(limit) : undefined,
    after:  after || undefined,
  });
  res.json({ tickets, total: tickets.length });
});

/**
 * GET /api/v1/network-settlement/tickets/:id
 * Get a specific Smart Transfer ticket.
 */
router.get('/tickets/:id', requireOps, async (req: Request, res: Response): Promise<void> => {
  const ticket = await getSmartTransferTicket(String(req.params['id'] ?? ''));
  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found', code: 'NOT_FOUND' });
    return;
  }
  res.json({ ticket });
});

/**
 * POST /api/v1/network-settlement/tickets
 * Create a Smart Transfer ticket.
 *
 * Body:
 * {
 *   type?: 'ASYNC' | 'ATOMIC',         // default ASYNC
 *   thirdParty?: boolean,              // true = intermediary opening for two third parties
 *   legs: [{ assetId, amount, srcNetworkId, dstNetworkId }],
 *   expiresAt?: string,                // ISO timestamp; default 24 h
 *   note?: string
 * }
 *
 * For thirdParty=true: the creating workspace, srcNetworkId, and dstNetworkId must
 * all share the same Fireblocks Network profile.
 */
router.post('/tickets', requireBankAuth, async (req: Request, res: Response): Promise<void> => {
  const { type, thirdParty, legs, expiresAt, note, settlementId } = req.body as {
    type?: 'ASYNC' | 'ATOMIC';
    thirdParty?: boolean;
    legs: Array<{ assetId: string; amount: string; srcNetworkId: string; dstNetworkId: string }>;
    expiresAt?: string;
    note?: string;
    settlementId?: string;
  };

  if (!Array.isArray(legs) || legs.length === 0) {
    res.status(400).json({ error: 'legs array is required and must be non-empty', code: 'VALIDATION_ERROR' });
    return;
  }

  for (const [i, leg] of legs.entries()) {
    if (!leg.assetId || !leg.amount || !leg.srcNetworkId || !leg.dstNetworkId) {
      res.status(400).json({
        error: `legs[${i}] must include assetId, amount, srcNetworkId, dstNetworkId`,
        code: 'VALIDATION_ERROR',
      });
      return;
    }
  }

  const dryRun = isDryRun(req);
  const ticket = await openSmartTransfer({ type, thirdParty, legs, expiresAt, note, settlementId, dryRun });

  res.status(dryRun ? 200 : 201).json({ ticket, dryRun });
});

/**
 * POST /api/v1/network-settlement/tickets/:ticketId/legs/:legId/fund
 * Fund a specific leg of an open Smart Transfer ticket.
 *
 * Body: { sourceVaultId: string, settlementId?: string }
 */
router.post('/tickets/:ticketId/legs/:legId/fund', requireBankAuth, async (req: Request, res: Response): Promise<void> => {
  const ticketId = req.params['ticketId'] as string;
  const legId    = req.params['legId'] as string;
  const { sourceVaultId, settlementId } = req.body as { sourceVaultId: string; settlementId?: string };

  if (!sourceVaultId) {
    res.status(400).json({ error: 'sourceVaultId is required', code: 'VALIDATION_ERROR' });
    return;
  }

  const dryRun = isDryRun(req);
  const leg = await fundTicketLeg({ ticketId, legId, sourceVaultId, settlementId, dryRun });

  res.json({ leg, dryRun });
});

/**
 * DELETE /api/v1/network-settlement/tickets/:id
 * Cancel an open Smart Transfer ticket (before any legs are funded).
 *
 * Body: { settlementId?: string }
 */
router.delete('/tickets/:id', requireBankAuth, async (req: Request, res: Response): Promise<void> => {
  const ticketId = String(req.params['id'] ?? '');
  const { settlementId } = req.body as { settlementId?: string };

  const dryRun = isDryRun(req);
  await cancelTicket({ ticketId, settlementId, dryRun });

  res.json({ cancelled: true, ticketId, dryRun });
});

// ── Direct network transfers (institution) ────────────────────────────────────

/**
 * POST /api/v1/network-settlement/transfers
 * Send funds directly through a Fireblocks Network connection.
 *
 * Body:
 * {
 *   assetId: string,               // e.g. "USDT_SOL"
 *   amount: string,                // string to preserve precision
 *   sourceVaultId: string,
 *   networkConnectionId: string,   // from GET /connections
 *   note?: string,
 *   settlementId: string,          // used as idempotency key prefix
 *   feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH'
 * }
 */
router.post('/transfers', requireBankAuth, async (req: Request, res: Response): Promise<void> => {
  const {
    assetId, amount, sourceVaultId, networkConnectionId,
    note, settlementId, feeLevel,
  } = req.body as {
    assetId: string;
    amount: string;
    sourceVaultId: string;
    networkConnectionId: string;
    note?: string;
    settlementId: string;
    feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  };

  if (!assetId || !amount || !sourceVaultId || !networkConnectionId || !settlementId) {
    res.status(400).json({
      error: 'assetId, amount, sourceVaultId, networkConnectionId, and settlementId are required',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  if (parseFloat(amount) <= 0 || isNaN(parseFloat(amount))) {
    res.status(400).json({ error: 'amount must be a positive number string', code: 'VALIDATION_ERROR' });
    return;
  }

  const dryRun = isDryRun(req);

  const tx = await initiateDirectSettlement({
    assetId, amount, sourceVaultId, networkConnectionId,
    note, settlementId, feeLevel, dryRun,
  });

  res.status(dryRun ? 200 : 201).json({
    transferId:          tx.id,
    status:              tx.status,
    externalTxId:        tx.externalTxId,
    networkConnectionId,
    assetId,
    amount,
    dryRun,
    note: dryRun
      ? 'Dry run — no actual transfer submitted to Fireblocks'
      : 'Transfer submitted to Fireblocks Network.',
  });
});

// ── Webhooks ──────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/network-settlement/webhooks
 *
 * Receives Fireblocks webhook events (transaction and Smart Transfer status changes,
 * connection approvals).
 *
 * Validates the RSA-SHA512 JWS signature on every payload before any processing.
 * Always responds 200 (Fireblocks retries on non-2xx with exponential backoff).
 */
router.post('/webhooks', async (req: Request, res: Response): Promise<void> => {
  // Express raw body middleware must be configured upstream for this route.
  // If rawBody is unavailable, fall back to JSON.stringify of the parsed body.
  const raw: string =
    (req as Request & { rawBody?: string }).rawBody ??
    JSON.stringify(req.body ?? {});

  const sig = String(req.headers['fireblocks-signature'] ?? '');

  let result;
  try {
    result = await handleFireblocksWebhook(raw, sig);
  } catch (err) {
    log.error('network_settlement.webhook.error', { error: (err as Error).message });
    // Still 200 — Fireblocks will retry on 5xx
    res.status(200).json({ received: true, error: 'internal_error' });
    return;
  }

  if (!result.handled && result.reason === 'invalid_signature') {
    // 401 is appropriate here — Fireblocks will retry and alert the workspace owner
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  res.status(200).json({ received: true, ...result });
});

export default router;
