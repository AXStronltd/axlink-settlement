import { Router, Request, Response } from 'express';
import { verifyWebhookSignature } from '../services/brainrock.service';
import { prisma, credit } from '../services/ledger.service';
import { handleFiatArrived } from '../services/orchestrator.service';

const router = Router();

// Brainrock fires webhooks here on every account event.
//
// payment.received  → fiat landed in user's virtual IBAN → triggers full deposit flow
// payment.sent      → outbound confirmed → marks withdrawal COMPLETED
// payment.failed    → outbound failed → reverses ledger debit, marks withdrawal REVERSED
router.post('/brainrock', async (req: Request, res: Response) => {
  const signature = (req.headers['x-brainrock-signature'] as string | undefined) ?? '';
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';

  const secretConfigured = (process.env.BRAINROCK_WEBHOOK_SECRET ?? '').length > 0;
  if (secretConfigured && !verifyWebhookSignature(rawBody, signature)) {
    res.status(401).json({ error: 'Invalid Brainrock webhook signature' });
    return;
  }

  const event = req.body as {
    type: string;
    data: {
      accountId?: string;
      paymentId?: string;
      amount?: number;
      currency?: string;
      senderName?: string;
      reference?: string;
      failureReason?: string;
    };
  };

  const { type, data } = event;
  console.log(`[Brainrock] event=${type} accountId=${data.accountId ?? '-'} paymentId=${data.paymentId ?? '-'} amount=${data.amount ?? '-'} ${data.currency ?? ''}`);

  // ── Inbound: fiat arrived in user's virtual IBAN ──────────────────────────
  if (type === 'payment.received' && data.accountId && data.amount && data.currency) {
    const user = await prisma.user.findFirst({ where: { brainrockAccountId: data.accountId } });

    if (!user) {
      console.warn(`[Brainrock] No user for accountId=${data.accountId} — possible manual transfer, investigate`);
      res.status(200).json({ received: true });
      return;
    }

    // Full deposit: B2BinPay on-ramp → USDT → Fireblocks → ledger credit
    await handleFiatArrived({
      userId: user.id,
      currency: data.currency,
      amount: data.amount,
      rail: 'brainrock',
      railReference: data.paymentId ?? data.reference ?? 'brainrock_unknown',
    });
  }

  // ── Outbound confirmed: fiat reached user's bank/M-Pesa ─────────────────
  if (type === 'payment.sent' && data.paymentId) {
    const withdrawal = await prisma.withdrawal.findFirst({
      where: { brainrockPaymentId: data.paymentId },
    });
    if (withdrawal) {
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'COMPLETED' },
      });
      console.log(`[Brainrock] Withdrawal ${withdrawal.trackingId} confirmed — fiat delivered`);
    }
  }

  // ── Outbound failed: reverse ledger debit ────────────────────────────────
  if (type === 'payment.failed' && data.paymentId) {
    const withdrawal = await prisma.withdrawal.findFirst({
      where: { brainrockPaymentId: data.paymentId, status: 'PENDING_PAYOUT' },
    });
    if (withdrawal) {
      await prisma.$transaction(async (tx: Parameters<typeof credit>[0]) => {
        await credit(tx, withdrawal.userId, withdrawal.currency, Number(withdrawal.amount));
      });
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'REVERSED' },
      });
      console.log(`[Brainrock] Withdrawal ${withdrawal.trackingId} reversed — ${data.failureReason ?? 'unknown reason'}`);
    }
  }

  res.status(200).json({ received: true });
});

export default router;
