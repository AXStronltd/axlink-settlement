import { Router, Request, Response } from 'express';
import { verifyWebhookSignature } from '../providers/live/choicebank';
import { prisma, credit } from '../core/ledger.service';
import { handleFiatArrived } from '../core/orchestrator.service';
import { confirmWithdrawalFromPartner } from '../core/settlement/payout-confirmation.service';

// ── Choice Bank Nigeria Webhook Handlers ──────────────────────────────────────
// Choice Bank fires these events on inbound and outbound transfer updates.
//
// Inbound events (fiat deposited to user's Choice Bank virtual account):
//   transfer.credit  → trigger full deposit flow into AxLink
//
// Outbound events (AxLink payout to user's bank):
//   transfer.success → mark withdrawal COMPLETED
//   transfer.failed  → reverse ledger debit, mark REVERSED

const router = Router();

router.post('/choicebank', async (req: Request, res: Response) => {
  const signature = (req.headers['x-choicebank-signature'] as string | undefined) ?? '';
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';

  const secretConfigured = (process.env.CHOICE_BANK_WEBHOOK_SECRET ?? '').length > 0 &&
    !process.env.CHOICE_BANK_WEBHOOK_SECRET?.startsWith('your_');

  if (secretConfigured && !verifyWebhookSignature(rawBody, signature)) {
    res.status(401).json({ error: 'Invalid Choice Bank webhook signature' });
    return;
  }

  // Acknowledge immediately before any async work
  res.status(200).json({ received: true });

  const event = req.body as {
    event:  string;    // transfer.credit | transfer.success | transfer.failed
    data: {
      id:                string;   // Choice Bank transfer ID
      reference:         string;   // Our trackingId (for outbound) or Choice Bank ref (inbound)
      amount:            number;
      currency:          string;   // NGN | GHS | ZAR
      accountId?:        string;   // Choice Bank virtual account ID (inbound only)
      accountNumber?:    string;   // Destination account (outbound confirmation)
      narration?:        string;
      failureReason?:    string;
      completedAt?:      string;
    };
  };

  const { event: eventType, data } = event;
  console.log(
    `[ChoiceBank] event=${eventType} id=${data.id} amount=${data.amount} ${data.currency} ref=${data.reference}`,
  );

  // ── Inbound: fiat landed in user's Choice Bank virtual account ────────────
  if (eventType === 'transfer.credit' && data.accountId) {
    const user = await prisma.user.findFirst({
      where: { choiceBankAccountId: data.accountId },
    });

    if (!user) {
      console.warn(`[ChoiceBank] No user for accountId=${data.accountId} — manual transfer, investigate`);
      return;
    }

    // Trigger full deposit: B2BinPay on-ramp → USDT → Fireblocks → ledger credit
    await handleFiatArrived({
      userId:        user.id,
      currency:      data.currency,
      amount:        data.amount,
      rail:          'choicebank',
      railReference: data.id,
    });

    console.log(`[ChoiceBank] Deposit triggered for user=${user.id} — ${data.amount} ${data.currency}`);
    return;
  }

  // ── Outbound confirmed: fiat reached user's bank account ─────────────────
  if (eventType === 'transfer.success' && data.reference) {
    // brainrockPaymentId stores the provider paymentId regardless of corridor
    const withdrawal = await prisma.withdrawal.findFirst({
      where: { brainrockPaymentId: data.id },
    });
    // Also try matching by our trackingId embedded in the reference
    const byRef = withdrawal ?? await prisma.withdrawal.findFirst({
      where: { trackingId: { contains: data.reference } },
    });

    if (byRef) {
      // Through the settlement engine: confirms the PARTNER_PAYOUT leg and
      // clears suspense. A direct status write would leave the books unbalanced.
      await confirmWithdrawalFromPartner({
        withdrawalId:     byRef.id,
        partnerReference: data.id,
        providerId:       'choicebank',
      });
    } else {
      console.warn(`[ChoiceBank] No withdrawal matched transferId=${data.id} ref=${data.reference}`);
    }
    return;
  }

  // ── Outbound failed: reverse ledger debit ────────────────────────────────
  if (eventType === 'transfer.failed' && data.reference) {
    const withdrawal = await prisma.withdrawal.findFirst({
      where: {
        OR: [
          { brainrockPaymentId: data.id },
          { trackingId: { contains: data.reference } },
        ],
        status: 'PENDING_PAYOUT',
      },
    });

    if (withdrawal) {
      await prisma.$transaction(async (tx: Parameters<typeof credit>[0]) => {
        await credit(tx, withdrawal.userId, withdrawal.currency, Number(withdrawal.amount));
      });
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'REVERSED' },
      });
      console.warn(
        `[ChoiceBank] Withdrawal ${withdrawal.trackingId} reversed — ${data.failureReason ?? 'unknown'}`,
      );
    } else {
      console.warn(`[ChoiceBank] No PENDING_PAYOUT withdrawal matched for failure event — transferId=${data.id}`);
    }
    return;
  }

  console.log(`[ChoiceBank] Unhandled event: ${eventType}`);
});

export default router;
