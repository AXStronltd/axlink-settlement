import { randomUUID } from 'crypto';
import { prisma } from './ledger.service';
import { classifyRoute, getSpread } from './smart-router.service';
import { createQuote } from './quote.service';
import { createTransfer as fbTransfer } from '../providers/live/fireblocks';
import { deliverBankWebhook, type BankWebhookPayload } from './bank-webhook.service';
import { audit } from './ledger.service';

const USDT_ASSET = process.env.FIREBLOCKS_USDT_ASSET ?? 'USDT_SOL';

// ── Per-bank daily limit check ────────────────────────────────────────────────

async function checkAndRecordUsage(bankId: string, dailyLimitUsd: number, usdAmount: number): Promise<void> {
  const date = new Date().toISOString().slice(0, 10); // "2026-06-12"

  const usage = await prisma.bankApiUsage.upsert({
    where:  { bankId_date: { bankId, date } },
    update: {},
    create: { bankId, date, settledUsd: 0, txCount: 0 },
  });

  const usedSoFar = Number(usage.settledUsd);
  if (usedSoFar + usdAmount > dailyLimitUsd) {
    throw Object.assign(
      new Error(
        `Daily settlement limit exceeded. ` +
        `Used: $${usedSoFar.toLocaleString()} / $${dailyLimitUsd.toLocaleString()} USD today. ` +
        `This transfer needs $${usdAmount.toFixed(2)} USD.`,
      ),
      { code: 'DAILY_LIMIT_EXCEEDED', statusCode: 422 },
    );
  }

  await prisma.bankApiUsage.update({
    where:  { bankId_date: { bankId, date } },
    data:   { settledUsd: { increment: usdAmount }, txCount: { increment: 1 } },
  });
}

// ── Per-corridor limit check ──────────────────────────────────────────────────

function checkCorridorLimit(
  corridorLimits: Record<string, number> | null,
  fromCurrency: string,
  toCurrency: string,
  usdAmount: number,
): void {
  if (!corridorLimits) return;
  const key   = `${fromCurrency}:${toCurrency}`;
  const limit = corridorLimits[key];
  if (limit !== undefined && usdAmount > limit) {
    throw Object.assign(
      new Error(`Corridor limit exceeded for ${key}: $${usdAmount.toFixed(2)} > $${limit.toLocaleString()} USD`),
      { code: 'CORRIDOR_LIMIT_EXCEEDED', statusCode: 422 },
    );
  }
}

// ── Idempotency check ─────────────────────────────────────────────────────────

async function checkIdempotency(bankId: string, bankReferenceId: string): Promise<void> {
  const existing = await prisma.interbankTransfer.findFirst({
    where: { senderBankId: bankId, bankReferenceId },
  });
  if (existing) {
    throw Object.assign(
      new Error(`Duplicate transfer: bankReferenceId ${bankReferenceId} already processed (trackingId: ${existing.trackingId})`),
      { code: 'DUPLICATE_REFERENCE', statusCode: 409, existingTrackingId: existing.trackingId },
    );
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function initiateInterbankTransfer(params: {
  senderBankId:    string;
  senderNetworkId: string;
  senderVaultId:   string;
  dailyLimitUsd:   number;
  corridorLimits:  Record<string, number> | null;
  webhookUrl:      string | null;
  webhookSecret:   string | null;
  receiverNetworkId: string;
  senderCurrency:  string;
  senderAmount:    number;
  receiverCurrency: string;
  bankReferenceId: string;
  senderName?:     string;
  senderAccount?:  string;
  receiverName?:   string;
  receiverAccount?: string;
  quoteId?:        string;
}) {
  const {
    senderBankId, senderNetworkId, senderVaultId,
    dailyLimitUsd, corridorLimits,
    webhookUrl, webhookSecret,
    receiverNetworkId,
    senderCurrency, senderAmount, receiverCurrency,
    bankReferenceId,
    senderName, senderAccount, receiverName, receiverAccount,
    quoteId,
  } = params;

  const fromN = senderCurrency.toUpperCase();
  const toN   = receiverCurrency.toUpperCase();

  // 1. Idempotency — reject duplicate bank references
  await checkIdempotency(senderBankId, bankReferenceId);

  // 2. Resolve receiving bank
  const receiverBank = await prisma.bank.findUnique({ where: { networkId: receiverNetworkId } });
  if (!receiverBank) {
    throw Object.assign(
      new Error(`Receiving bank ${receiverNetworkId} is not a member of the AxLink network`),
      { code: 'UNKNOWN_RECEIVER_BANK', statusCode: 404 },
    );
  }
  if (receiverBank.status !== 'ACTIVE') {
    throw Object.assign(
      new Error(`Receiving bank ${receiverNetworkId} is currently ${receiverBank.status}`),
      { code: 'RECEIVER_BANK_SUSPENDED', statusCode: 422 },
    );
  }

  // 3. FX quote (uses smart router — 0 spread for IDENTITY/STABLE, corridor spread otherwise)
  const quote = quoteId
    ? await import('./quote.service').then(m => m.consumeQuote(quoteId))
    : await createQuote({ fromCurrency: fromN, toCurrency: toN, fromAmount: senderAmount });

  const { toAmount: receiverAmount, usdAmount, usdtAmount, rate: fxRate, lpSource } = quote;
  const routeType = classifyRoute(fromN, toN);
  const spread    = getSpread(fromN, toN);

  // 4. Daily + corridor limit checks
  await checkAndRecordUsage(senderBankId, dailyLimitUsd, usdAmount);
  checkCorridorLimit(corridorLimits, fromN, toN, usdAmount);

  const trackingId = `ibt_${randomUUID()}`;

  // 5. Create transfer record
  const transfer = await prisma.interbankTransfer.create({
    data: {
      trackingId, bankReferenceId,
      senderBankId,
      senderCurrency: fromN, senderAmount,
      receiverBankId: receiverBank.id,
      receiverCurrency: toN, receiverAmount,
      usdAmount, usdtAmount,
      fxRate, routeType, spread: spread,
      lpSource,
      senderName, senderAccount,
      receiverName, receiverAccount,
      status: 'PROCESSING',
    },
  });

  await audit('InterbankTransfer', transfer.id, 'CREATED', {
    from: `${senderAmount} ${fromN}`, to: `${receiverAmount} ${toN}`,
    routeType, spread, usdAmount,
    sender: senderNetworkId, receiver: receiverNetworkId,
  });

  try {
    // 6. Fireblocks vault-to-vault settlement
    const fbTx = await fbTransfer({
      assetId:       USDT_ASSET,
      amount:        usdtAmount.toString(),
      sourceVaultId: senderVaultId,
      destVaultId:   receiverBank.vaultId,
      note:          `AxLink interbank ${trackingId} — ${senderNetworkId}→${receiverNetworkId}`,
      externalTxId:  trackingId,
    });

    const done = await prisma.interbankTransfer.update({
      where: { id: transfer.id },
      data:  { status: 'COMPLETED', fbTxId: fbTx?.id as string | undefined },
    });

    await audit('InterbankTransfer', transfer.id, 'COMPLETED', { fbTxId: fbTx?.id });

    // 7. Fire outbound webhook to sender bank (non-blocking)
    if (webhookUrl) {
      const webhookPayload: BankWebhookPayload = {
        event:            'transfer.settled',
        trackingId,
        bankReferenceId,
        senderBankId:     senderNetworkId,
        receiverBankId:   receiverNetworkId,
        senderCurrency:   fromN,
        senderAmount,
        receiverCurrency: toN,
        receiverAmount,
        fxRate:           fxRate ?? null,
        routeType,
        fbTxId:           fbTx?.id as string | null ?? null,
        solanaTxHash:     null,
        settledAt:        new Date().toISOString(),
      };
      deliverBankWebhook(webhookUrl, webhookSecret, webhookPayload).then(delivered => {
        if (delivered) {
          prisma.interbankTransfer.update({
            where: { id: transfer.id },
            data:  { webhookDelivered: true },
          }).catch(() => {});
        }
      });
    }

    // 8. Also notify receiving bank
    if (receiverBank.webhookUrl) {
      const rxPayload: BankWebhookPayload = {
        event:            'transfer.settled',
        trackingId,
        bankReferenceId,
        senderBankId:     senderNetworkId,
        receiverBankId:   receiverNetworkId,
        senderCurrency:   fromN,   senderAmount,
        receiverCurrency: toN,     receiverAmount,
        fxRate:           fxRate ?? null,
        routeType,
        fbTxId:           fbTx?.id as string | null ?? null,
        solanaTxHash:     null,
        settledAt:        new Date().toISOString(),
      };
      deliverBankWebhook(receiverBank.webhookUrl, receiverBank.webhookSecret, rxPayload).catch(() => {});
    }

    return done;

  } catch (err) {
    await prisma.interbankTransfer.update({
      where: { id: transfer.id },
      data:  { status: 'FAILED' },
    });
    await audit('InterbankTransfer', transfer.id, 'FAILED', { error: String(err) });
    throw err;
  }
}

// ── Statement / reconciliation query ─────────────────────────────────────────

export async function getBankStatement(bankId: string, date: string) {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end   = new Date(`${date}T23:59:59.999Z`);

  const transfers = await prisma.interbankTransfer.findMany({
    where: {
      OR: [{ senderBankId: bankId }, { receiverBankId: bankId }],
      createdAt: { gte: start, lte: end },
    },
    orderBy: { createdAt: 'asc' },
  });

  const usage = await prisma.bankApiUsage.findUnique({
    where: { bankId_date: { bankId, date } },
  });

  return {
    date,
    bankId,
    totalTransfers: transfers.length,
    totalSettledUsd: Number(usage?.settledUsd ?? 0),
    transfers: transfers.map(t => ({
      trackingId:      t.trackingId,
      bankReferenceId: t.bankReferenceId,
      direction:       t.senderBankId === bankId ? 'SENT' : 'RECEIVED',
      senderCurrency:  t.senderCurrency,
      senderAmount:    Number(t.senderAmount),
      receiverCurrency: t.receiverCurrency,
      receiverAmount:  Number(t.receiverAmount),
      usdAmount:       Number(t.usdAmount),
      fxRate:          t.fxRate ? Number(t.fxRate) : null,
      routeType:       t.routeType,
      spread:          Number(t.spread),
      status:          t.status,
      fbTxId:          t.fbTxId,
      settledAt:       t.createdAt,
    })),
  };
}
