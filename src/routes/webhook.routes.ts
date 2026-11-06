import { Router, Request, Response } from 'express';
import { admitWebhook, isSecretConfigured, rejectWebhook } from '../platform/webhook-policy';
import { verifyWebhookSignature, TRANSFER_STATUS } from '../providers/live/b2binpay';
import { verifyFireblocksWebhook, TX_STATUS } from '../providers/live/fireblocks';
import { prisma, credit } from '../core/ledger.service';
import { processOnce, EventIgnored } from '../core/provider-events/provider-event.service';
import { applyCustodyDeposit } from '../core/provider-events/custody-deposit';
import { legByExternalKey, mergeLegPayload, confirmLeg, isTerminal } from '../core/settlement/leg.service';

const router = Router();

// B2BinPay POSTs to /webhooks/b2binpay on every transfer status change.
// Raw body buffering is set up in index.ts so we can verify the HMAC signature.
router.post('/b2binpay', async (req: Request, res: Response) => {
  const signature = (req.headers['x-callback-signature'] as string | undefined) ?? '';
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';

  const verdict = admitWebhook({ provider: 'b2binpay', secretConfigured: isSecretConfigured(process.env.B2BINPAY_CALLBACK_SECRET), signaturePresent: !!signature, verify: () => verifyWebhookSignature(rawBody, signature) });
  if (!verdict.ok) { rejectWebhook(res, verdict); return; }

  const payload = req.body as {
    data?: {
      id?: string;
      attributes?: {
        status?: number;
        amount?: string;
        txid?: string;
        tracking_id?: string;
        confirmations?: number;
      };
    };
  };

  const attrs       = payload.data?.attributes;
  const transferId  = payload.data?.id;
  const statusCode  = attrs?.status ?? 0;
  const statusLabel = TRANSFER_STATUS[statusCode] ?? 'unknown';
  const trackingId  = attrs?.tracking_id ?? '';

  console.log(`[B2BinPay] transfer=${transferId} status=${statusCode}(${statusLabel}) txid=${attrs?.txid ?? '-'} amount=${attrs?.amount ?? '-'} tracking=${trackingId || '-'}`);

  // ── Settlement legs ────────────────────────────────────────────────────────
  //
  // Every leg hands the partner its `externalKey` as the tracking id, so this
  // callback identifies the leg that caused it. Two things have to happen here
  // and neither did before:
  //
  //   1. The on-chain hash arrives on this callback and nowhere else.
  //      ONCHAIN_SETTLE reads it from payload.signature to know what to verify,
  //      and nothing wrote that field — so the proof leg had nothing to check
  //      and a deposit could not be settled in production at all.
  //
  //   2. A leg parked at AWAITING_CONFIRMATION is waiting for exactly this
  //      message. Without it the settlement stalls at its first async leg.
  //
  // Deliberately does NOT complete the leg on a txid alone. A hash means the
  // partner broadcast something, not that it settled — that is ONCHAIN_SETTLE's
  // job, against the chain. Recording the hash and confirming the custody leg
  // are different claims and this only makes the second one.
  if (trackingId) {
    const leg = await legByExternalKey(trackingId);
    if (leg && !isTerminal(leg.status)) {
      if (attrs?.txid) {
        await mergeLegPayload(leg.id, { signature: attrs.txid });
        console.log(`[B2BinPay] leg ${leg.entityType}:${leg.entityId}#${leg.sequence} carries chain hash ${attrs.txid}`);
      }
      if (statusLabel === 'confirmed' && leg.status === 'AWAITING_CONFIRMATION') {
        await confirmLeg(leg.id, transferId ?? undefined);
        console.log(`[B2BinPay] leg ${leg.entityType}:${leg.entityId}#${leg.sequence} (${leg.kind}) confirmed`);
      }
    }
  }

  // Mirror B2BinPay USDT transfer status onto our deposit/withdrawal record.
  // Final credit/debit is gated on the Fireblocks confirmation webhook — this
  // just keeps the intermediate status observable for ops and auditing.
  if (trackingId) {
    if (trackingId.startsWith('dep_')) {
      const deposit = await prisma.bankDeposit.findUnique({ where: { trackingId } });
      if (deposit && deposit.status === 'PROCESSING') {
        if (statusLabel === 'failed' || statusLabel === 'cancelled') {
          await prisma.bankDeposit.update({
            where: { id: deposit.id },
            data:  { status: 'FAILED', onrampId: transferId },
          });
          console.log(`[B2BinPay] Deposit ${trackingId} marked FAILED — B2BinPay status: ${statusLabel}`);
        } else if (statusLabel === 'pending' || statusLabel === 'processing') {
          await prisma.bankDeposit.update({
            where: { id: deposit.id },
            data:  { onrampId: transferId },
          });
        }
      }
    } else if (trackingId.startsWith('out_')) {
      if (statusLabel === 'failed' || statusLabel === 'canceled' || statusLabel === 'cancelled') {
        // B2BinPay failed to convert the stablecoin → fiat: reverse the ledger debit exactly once (F1).
        // The reversal credit and the REVERSED status are one transaction, claimed by the event row.
        const r = await processOnce({ provider: 'b2binpay', eventId: `${transferId ?? trackingId}:${statusCode}`, kind: 'transfer.status', rawBody }, async (tx) => {
          const withdrawal = await tx.withdrawal.findUnique({ where: { trackingId } });
          if (!withdrawal) throw new EventIgnored({ status: 'IGNORED', reason: `no withdrawal ${trackingId}` });
          const user = await tx.user.findUnique({ where: { id: withdrawal.userId }, select: { institutionId: true, vaultId: true } });
          const attribution = { institutionId: user?.institutionId ?? null, vaultId: user?.vaultId ?? null, entityType: 'Withdrawal', entityId: withdrawal.id };
          const flipped = await tx.withdrawal.updateMany({ where: { id: withdrawal.id, status: 'PENDING_B2BINPAY' }, data: { status: 'REVERSED' } });
          if (flipped.count !== 1) throw new EventIgnored({ status: 'IGNORED', reason: `withdrawal not pending (status ${withdrawal.status})`, ...attribution });
          await credit(tx, withdrawal.userId, withdrawal.currency, withdrawal.amount);
          return { outcome: { status: 'PROCESSED' as const, ...attribution }, result: null };
        });
        if (r.duplicate) { res.status(200).json({ received: true, duplicate: true }); return; }
        if (r.outcome.status === 'PROCESSED') console.log(`[B2BinPay] Withdrawal ${trackingId} reversed — B2BinPay status: ${statusLabel}`);
      }
    }
  }

  res.status(200).json({ received: true });
});

// Fireblocks POSTs to /webhooks/fireblocks (or /fireboks — registered alias).
// Verify with the Fireblocks public key (from Console → Webhooks).
router.post(['/fireblocks', '/fireboks'], async (req: Request, res: Response) => {
  const signature = (req.headers['fireblocks-signature'] as string | undefined) ?? '';
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';

  const verdict = admitWebhook({ provider: 'fireblocks', secretConfigured: isSecretConfigured(process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY), signaturePresent: !!signature, verify: () => verifyFireblocksWebhook(rawBody, signature) });
  if (!verdict.ok) { rejectWebhook(res, verdict); return; }

  const payload = req.body as {
    type?: string;
    data?: {
      id?: string;
      status?: string;
      assetId?: string;
      amount?: number;
      fee?: number;
      txHash?: string;
      externalTxId?: string;
      source?: { id?: string; name?: string };
      destination?: { id?: string; name?: string };
    };
  };

  const event       = payload.type ?? 'UNKNOWN';
  const tx          = payload.data;
  const statusLabel = TX_STATUS[tx?.status ?? ''] ?? tx?.status ?? 'unknown';

  console.log(
    `[Fireblocks webhook] event=${event} txId=${tx?.id ?? '-'} status=${statusLabel} asset=${tx?.assetId ?? '-'} amount=${tx?.amount ?? '-'} hash=${tx?.txHash ?? '-'} externalId=${tx?.externalTxId ?? '-'} destVault=${tx?.destination?.id ?? '-'}`
  );

  // ── A stablecoin landed in a custody vault → settle the matching deposit ───
  // F1: exactly once per (tx id, status) via ProviderEvent uniqueness, in one transaction.
  // F3: the asset is resolved from the registry by network + contract; USDC and USDT both settle;
  //     anything else is recorded as IGNORED and never credits.
  if (statusLabel === 'completed' && tx?.id) {
    const r = await processOnce(
      { provider: 'fireblocks', eventId: `${tx.id}:${tx.status ?? 'COMPLETED'}`, kind: event, rawBody },
      (t) => applyCustodyDeposit(t, {
        provider: 'fireblocks', providerAssetId: tx.assetId, destinationVaultId: tx.destination?.id,
        externalTxId: tx.externalTxId, providerTxId: tx.id, amount: tx.amount,
      }),
    );
    if (r.duplicate) { res.status(200).json({ received: true, duplicate: true }); return; }
    if (r.outcome.status === 'PROCESSED' && r.result) {
      console.log(`[Fireblocks → Ledger] Credited ${r.result.credited} ${r.result.currency} for ${r.result.asset.id} (${r.result.asset.contract}) vault ${tx.destination?.id}`);
    }
    res.status(200).json({ received: true, outcome: r.outcome.status });
    return;
  }

  res.status(200).json({ received: true });
});

export default router;
