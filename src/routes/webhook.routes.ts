import { Router, Request, Response } from 'express';
import { verifyWebhookSignature, TRANSFER_STATUS } from '../providers/live/b2binpay';
import { verifyFireblocksWebhook, TX_STATUS } from '../providers/live/fireblocks';
import { prisma, credit } from '../core/ledger.service';
import { legByExternalKey, mergeLegPayload, confirmLeg, isTerminal } from '../core/settlement/leg.service';

const router = Router();

// B2BinPay POSTs to /webhooks/b2binpay on every transfer status change.
// Raw body buffering is set up in index.ts so we can verify the HMAC signature.
router.post('/b2binpay', async (req: Request, res: Response) => {
  const signature = (req.headers['x-callback-signature'] as string | undefined) ?? '';
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';

  const b2bSecret = process.env.B2BINPAY_CALLBACK_SECRET ?? '';
  const secretConfigured = b2bSecret.length > 0 && !b2bSecret.startsWith('your_');
  if (secretConfigured) {
    if (!signature || !verifyWebhookSignature(rawBody, signature)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }
  }

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
      const withdrawal = await prisma.withdrawal.findUnique({ where: { trackingId } });
      if (withdrawal && withdrawal.status === 'PENDING_B2BINPAY') {
        if (statusLabel === 'failed' || statusLabel === 'cancelled') {
          // B2BinPay failed to convert USDT → fiat — reverse the ledger debit
          await prisma.$transaction(async (tx) => {
            await credit(tx as Parameters<typeof credit>[0], withdrawal.userId, withdrawal.currency, withdrawal.amount);
          });
          await prisma.withdrawal.update({
            where: { id: withdrawal.id },
            data:  { status: 'REVERSED' },
          });
          console.log(`[B2BinPay] Withdrawal ${trackingId} reversed — B2BinPay status: ${statusLabel}`);
        }
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

  if (!verifyFireblocksWebhook(rawBody, signature)) {
    res.status(401).json({ error: 'Invalid Fireblocks webhook signature' });
    return;
  }

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

  // ── When USDT lands in a user's Fireblocks vault → credit their ledger ──────
  // This fires after B2BinPay sends USDT directly to user's vault address.
  // The externalTxId contains our trackingId so we can match to the deposit record.
  if (statusLabel === 'completed' && tx?.assetId?.startsWith('USDT') && tx?.destination?.id) {
    const destVaultId  = tx.destination.id;
    const externalTxId = tx?.externalTxId ?? '';

    // Find the user by their vault ID
    const user = await prisma.user.findUnique({ where: { vaultId: destVaultId } });
    if (user) {
      // Match deposit by trackingId (from externalTxId) when available — avoids
      // ambiguity when multiple deposits are PENDING_FIREBLOCKS simultaneously.
      const deposit = externalTxId.startsWith('dep_')
        ? await prisma.bankDeposit.findUnique({ where: { trackingId: externalTxId } })
        : await prisma.bankDeposit.findFirst({
            where: { userId: user.id, status: 'PENDING_FIREBLOCKS' },
            orderBy: { createdAt: 'desc' },
          });

      if (deposit) {
        // ✅ USDT confirmed in Fireblocks vault — credit the user's fiat ledger
        await prisma.$transaction(async (tx2: Parameters<typeof credit>[0]) => {
          await credit(tx2, user.id, deposit.currency, deposit.amount);
        });

        await prisma.bankDeposit.update({
          where: { id: deposit.id },
          data: { status: 'COMPLETED', fbTxId: tx?.id },
        });

        console.log(
          `[Fireblocks → Ledger] Credited ${deposit.amount} ${deposit.currency} to user ${user.id} (vault: ${destVaultId}) after USDT confirmed`
        );
      }
    }
  }

  res.status(200).json({ received: true });
});

export default router;
