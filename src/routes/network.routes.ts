import { Router, Request, Response } from 'express';
import { requireBankAuth, generateApiKey } from '../middleware/auth.middleware';
import { requireOps } from '../platform/ops-auth';
import { prisma } from '../core/ledger.service';
import { initiateInterbankTransfer, getBankStatement } from '../core/interbank.service';
import { createQuote } from '../core/quote.service';
import { classifyRoute, getSpread, describeRoute } from '../core/smart-router.service';
import { getSupportedCorridors, getRegisteredProviders } from '../core/baas-registry.service';

const router = Router();

// ── Bank registration (admin/internal — not authenticated by bank API key) ───
// POST /api/network/banks/register

router.post('/banks/register', requireOps, async (req: Request, res: Response): Promise<void> => {
  const { name, networkId, vaultId, webhookUrl, webhookSecret, dailyLimitUsd, corridorLimits } = req.body as {
    name: string;
    networkId: string;          // "AXLK-KE-001"
    vaultId: string;            // Fireblocks vault ID for this bank
    webhookUrl?: string;
    webhookSecret?: string;
    dailyLimitUsd?: number;
    corridorLimits?: Record<string, number>;
  };

  if (!name || !networkId || !vaultId) {
    res.status(400).json({ error: 'name, networkId, and vaultId are required', code: 'VALIDATION_ERROR' });
    return;
  }

  // networkId must match pattern AXLK-XX-NNN
  if (!/^AXLK-[A-Z]{2}-\d{3}$/.test(networkId)) {
    res.status(400).json({
      error: 'networkId must be in format AXLK-XX-NNN (e.g. AXLK-KE-001)',
      code: 'INVALID_NETWORK_ID',
    });
    return;
  }

  const existing = await prisma.bank.findUnique({ where: { networkId } });
  if (existing) {
    res.status(409).json({ error: `networkId ${networkId} is already registered`, code: 'DUPLICATE_NETWORK_ID' });
    return;
  }

  const { rawKey, hash } = generateApiKey();

  const bank = await prisma.bank.create({
    data: {
      name,
      networkId,
      apiKeyHash:    hash,
      vaultId,
      webhookUrl:    webhookUrl ?? null,
      webhookSecret: webhookSecret ?? null,
      dailyLimitUsd: dailyLimitUsd ?? 1_000_000,
      corridorLimits: corridorLimits !== undefined ? corridorLimits : undefined,
      status: 'ACTIVE',
    },
    select: { id: true, name: true, networkId: true, status: true, dailyLimitUsd: true, createdAt: true },
  });

  // rawKey is returned ONCE here and never stored; hash is persisted
  res.status(201).json({
    bank,
    apiKey: rawKey,
    warning: 'Store this API key immediately — it will NOT be shown again.',
  });
});

// ── Live rate feed (authenticated) ───────────────────────────────────────────
// GET /api/network/rates?from=GBP&to=KES&amount=10000

router.get('/rates', requireBankAuth, async (req: Request, res: Response): Promise<void> => {
  const from   = String(req.query.from ?? '').toUpperCase();
  const to     = String(req.query.to ?? '').toUpperCase();
  const amount = parseFloat(String(req.query.amount ?? '1000'));

  if (!from || !to) {
    res.status(400).json({ error: 'from and to currency codes are required', code: 'VALIDATION_ERROR' });
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: 'amount must be a positive number', code: 'VALIDATION_ERROR' });
    return;
  }

  const routeType = classifyRoute(from, to);
  const spread    = getSpread(from, to);
  const description = describeRoute(from, to);

  if (routeType === 'IDENTITY' || routeType === 'STABLE') {
    res.json({
      from, to, amount,
      rate:        1,
      toAmount:    amount,
      spread:      0,
      routeType,
      description,
      lockedQuoteId: null,
      validFor:    null,
      source:      routeType.toLowerCase(),
    });
    return;
  }

  // Lock a real quote for this rate — bank can reference quoteId in the transfer
  const quote = await createQuote({ fromCurrency: from, toCurrency: to, fromAmount: amount });

  res.json({
    from,
    to,
    amount,
    rate:          quote.rate,
    toAmount:      quote.toAmount,
    spread:        spread,
    spreadPct:     `${(spread * 100).toFixed(2)}%`,
    routeType,
    description,
    usdEquivalent: quote.usdAmount,
    lockedQuoteId: quote.id,
    validForMs:    30_000,
    validUntil:    new Date(Date.now() + 30_000).toISOString(),
    source:        quote.lpSource,
  });
});

// ── Initiate interbank transfer (authenticated) ───────────────────────────────
// POST /api/network/transfers

router.post('/transfers', requireBankAuth, async (req: Request, res: Response): Promise<void> => {
  const bank = req.bank!;

  const {
    receiverNetworkId,
    senderCurrency,
    senderAmount,
    receiverCurrency,
    bankReferenceId,
    senderName,
    senderAccount,
    receiverName,
    receiverAccount,
    quoteId,
  } = req.body as {
    receiverNetworkId: string;
    senderCurrency:    string;
    senderAmount:      number;
    receiverCurrency:  string;
    bankReferenceId:   string;
    senderName?:       string;
    senderAccount?:    string;
    receiverName?:     string;
    receiverAccount?:  string;
    quoteId?:          string;
  };

  if (!receiverNetworkId || !senderCurrency || !senderAmount || !receiverCurrency || !bankReferenceId) {
    res.status(400).json({
      error: 'receiverNetworkId, senderCurrency, senderAmount, receiverCurrency, and bankReferenceId are required',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  if (typeof senderAmount !== 'number' || senderAmount <= 0) {
    res.status(400).json({ error: 'senderAmount must be a positive number', code: 'VALIDATION_ERROR' });
    return;
  }

  if (receiverNetworkId === bank.networkId) {
    res.status(400).json({ error: 'Cannot send a transfer to yourself', code: 'SELF_TRANSFER' });
    return;
  }

  const transfer = await initiateInterbankTransfer({
    senderBankId:     bank.id,
    senderNetworkId:  bank.networkId,
    senderVaultId:    bank.vaultId,
    dailyLimitUsd:    bank.dailyLimitUsd,
    corridorLimits:   bank.corridorLimits,
    webhookUrl:       bank.webhookUrl,
    webhookSecret:    bank.webhookSecret,
    receiverNetworkId,
    senderCurrency,
    senderAmount,
    receiverCurrency,
    bankReferenceId,
    senderName,
    senderAccount,
    receiverName,
    receiverAccount,
    quoteId,
  });

  res.status(201).json({
    trackingId:       transfer.trackingId,
    bankReferenceId:  transfer.bankReferenceId,
    status:           transfer.status,
    senderCurrency:   transfer.senderCurrency,
    senderAmount:     Number(transfer.senderAmount),
    receiverCurrency: transfer.receiverCurrency,
    receiverAmount:   Number(transfer.receiverAmount),
    usdAmount:        Number(transfer.usdAmount),
    fxRate:           transfer.fxRate ? Number(transfer.fxRate) : null,
    routeType:        transfer.routeType,
    spread:           Number(transfer.spread),
    fbTxId:           transfer.fbTxId,
    settledAt:        transfer.updatedAt,
  });
});

// ── Transfer status (authenticated) ─────────────────────────────────────────
// GET /api/network/transfers/:id

router.get('/transfers/:id', requireBankAuth, async (req: Request, res: Response): Promise<void> => {
  const bank = req.bank!;
  const id = req.params['id'] as string;

  const transfer = await prisma.interbankTransfer.findUnique({ where: { trackingId: id } });

  if (!transfer) {
    res.status(404).json({ error: `Transfer ${id} not found`, code: 'NOT_FOUND' });
    return;
  }

  // Enforce that only the sender or receiver bank can view this transfer
  if (transfer.senderBankId !== bank.id && transfer.receiverBankId !== bank.id) {
    res.status(404).json({ error: `Transfer ${id} not found`, code: 'NOT_FOUND' });
    return;
  }

  res.json({
    trackingId:       transfer.trackingId,
    bankReferenceId:  transfer.bankReferenceId,
    status:           transfer.status,
    senderCurrency:   transfer.senderCurrency,
    senderAmount:     Number(transfer.senderAmount),
    receiverCurrency: transfer.receiverCurrency,
    receiverAmount:   Number(transfer.receiverAmount),
    usdAmount:        Number(transfer.usdAmount),
    fxRate:           transfer.fxRate ? Number(transfer.fxRate) : null,
    routeType:        transfer.routeType,
    spread:           Number(transfer.spread),
    fbTxId:           transfer.fbTxId,
    solanaTxHash:     transfer.solanaTxHash,
    webhookDelivered: transfer.webhookDelivered,
    createdAt:        transfer.createdAt,
    updatedAt:        transfer.updatedAt,
  });
});

// ── Daily statement / reconciliation (authenticated) ─────────────────────────
// GET /api/network/statement?date=2026-06-12

router.get('/statement', requireBankAuth, async (req: Request, res: Response): Promise<void> => {
  const bank = req.bank!;
  const dateParam = String(req.query.date ?? '');

  const date = dateParam || new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD', code: 'VALIDATION_ERROR' });
    return;
  }

  const statement = await getBankStatement(bank.id, date);
  res.json(statement);
});

// ── Network member list (authenticated — redacted for privacy) ───────────────
// GET /api/network/members

router.get('/members', requireBankAuth, async (_req: Request, res: Response): Promise<void> => {
  const banks = await prisma.bank.findMany({
    where:  { status: 'ACTIVE' },
    select: { networkId: true, name: true, status: true },
    orderBy: { name: 'asc' },
  });

  res.json({ members: banks, total: banks.length });
});

// ── Corridor + payout method discovery (authenticated) ───────────────────────
// GET /api/network/corridors
// Returns all supported currencies, their delivery methods, and which
// BaaS providers cover them.  Banks use this to know what payouts are possible.

router.get('/corridors', requireBankAuth, (_req: Request, res: Response): void => {
  const corridors  = getSupportedCorridors();
  const providers  = getRegisteredProviders();

  res.json({
    corridors,
    providers,
    note: 'Zero pre-funded. All corridors are JIT — no standing fiat balances. No SWIFT.',
  });
});

export default router;
