import { Router, Request, Response } from 'express';
import { verifyWebhookSignature, TRANSFER_STATUS } from '../providers/live/b2binpay';
import { verifyFireblocksWebhook, TX_STATUS } from '../providers/live/fireblocks';
import { prisma, credit } from '../core/ledger.service';

const router = Router();

// B2BinPay POSTs to /webhooks/b2binpay on every transfer status change.
// Raw body buffering is set up in index.ts so we can verify the HMAC signature.
router.post('/b2binpay', (req: Request, res: Response) => {
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

  const attrs = payload.data?.attributes;
  const transferId = payload.data?.id;
  const statusCode = attrs?.status ?? 0;
  const statusLabel = TRANSFER_STATUS[statusCode] ?? 'unknown';

  console.log(`[B2BinPay webhook] transfer=${transferId} status=${statusCode}(${statusLabel}) txid=${attrs?.txid ?? '-'} amount=${attrs?.amount ?? '-'} tracking=${attrs?.tracking_id ?? '-'}`);

  // TODO: persist to DB, emit event, notify user via WS/push
  // Example: await db.settlement.upsert({ where: { transferId }, data: { statusCode, txid } })

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
          await credit(tx2, user.id, deposit.currency, Number(deposit.amount));
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
