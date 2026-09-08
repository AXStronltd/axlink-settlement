import { Router, Request, Response } from 'express';
import { parseB2CCallback, parseSTKCallback, type B2CCallback, type STKCallbackResult } from '../providers/live/daraja';
import { prisma, credit } from '../core/ledger.service';
import { handleFiatArrived } from '../core/orchestrator.service';
import { confirmWithdrawalFromPartner } from '../core/settlement/payout-confirmation.service';

// ── Daraja Webhook Handlers ───────────────────────────────────────────────────
// Safaricom fires these callbacks on B2C (payout) and STK Push (deposit) events.
//
// No HMAC verification — Daraja doesn't sign callbacks.
// Secure by: whitelist Safaricom IP ranges at nginx/firewall level,
// and verify OriginatorConversationID matches a known trackingId in DB.

const router = Router();

// ── B2C Result — payout confirmed or failed ───────────────────────────────────
// POST /webhooks/daraja/b2c/result
// Fires after Safaricom processes a BusinessPayment to a subscriber.
router.post('/daraja/b2c/result', async (req: Request, res: Response) => {
  // Acknowledge immediately — Safaricom retries if we don't respond within 60s
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const body = req.body as B2CCallback;
  const parsed = parseB2CCallback(body);

  console.log(
    `[Daraja B2C] conversationId=${parsed.conversationId} success=${parsed.success} txId=${parsed.transactionId ?? '-'} amount=${parsed.amount ?? '-'}`,
  );

  // OriginatorConversationID = our trackingId (set in sendB2C reference field)
  const originatorId = body.Result?.OriginatorConversationID ?? '';

  const withdrawal = await prisma.withdrawal.findFirst({
    where: { trackingId: { contains: originatorId } },
  });

  if (!withdrawal) {
    console.warn(`[Daraja B2C] No withdrawal matched OriginatorConversationID=${originatorId}`);
    return;
  }

  if (parsed.success) {
    // Through the settlement engine: confirms the PARTNER_PAYOUT leg and clears
    // suspense. A direct status write here would leave the books unbalanced.
    await confirmWithdrawalFromPartner({
      withdrawalId:     withdrawal.id,
      partnerReference: parsed.transactionId ?? originatorId,
      providerId:       'daraja',
    });
  } else {
    // Reverse: credit user back
    await prisma.$transaction(async (tx: Parameters<typeof credit>[0]) => {
      await credit(tx, withdrawal.userId, withdrawal.currency, Number(withdrawal.amount));
    });
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { status: 'REVERSED' },
    });
    console.warn(`[Daraja B2C] Withdrawal ${withdrawal.trackingId} failed — ${parsed.failureReason}`);
  }
});

// ── B2C Timeout — Safaricom couldn't process in time ─────────────────────────
// POST /webhooks/daraja/b2c/timeout
// Treat same as failure: reverse the ledger debit so user isn't stuck.
router.post('/daraja/b2c/timeout', async (req: Request, res: Response) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const body = req.body as { Result?: { OriginatorConversationID?: string; ConversationID?: string } };
  const originatorId = body.Result?.OriginatorConversationID ?? '';

  console.warn(`[Daraja B2C timeout] OriginatorConversationID=${originatorId}`);

  const withdrawal = await prisma.withdrawal.findFirst({
    where: { trackingId: { contains: originatorId }, status: 'PENDING_PAYOUT' },
  });

  if (!withdrawal) return;

  await prisma.$transaction(async (tx: Parameters<typeof credit>[0]) => {
    await credit(tx, withdrawal.userId, withdrawal.currency, Number(withdrawal.amount));
  });
  await prisma.withdrawal.update({
    where: { id: withdrawal.id },
    data: { status: 'REVERSED' },
  });
  console.warn(`[Daraja B2C timeout] Withdrawal ${withdrawal.trackingId} reversed`);
});

// ── STK Push Callback — deposit from customer's M-Pesa ───────────────────────
// POST /webhooks/daraja/stk
// Fires after user enters their M-Pesa PIN (or cancels).
// We store CheckoutRequestID in BankDeposit.onrampId when initiating the push.
router.post('/daraja/stk', async (req: Request, res: Response) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const body = req.body as STKCallbackResult;
  const parsed = parseSTKCallback(body);

  console.log(
    `[Daraja STK] checkoutRequestId=${parsed.checkoutRequestId} success=${parsed.success} receipt=${parsed.mpesaReceiptNumber ?? '-'} amount=${parsed.amount ?? '-'}`,
  );

  // BankDeposit.onrampId = CheckoutRequestID (set when STK push was initiated)
  const deposit = await prisma.bankDeposit.findFirst({
    where: { onrampId: parsed.checkoutRequestId, status: 'PROCESSING' },
  });

  if (!deposit) {
    console.warn(`[Daraja STK] No deposit matched CheckoutRequestID=${parsed.checkoutRequestId}`);
    return;
  }

  if (parsed.success) {
    // Customer paid — trigger full deposit flow (B2BinPay on-ramp → USDT → Fireblocks → ledger)
    await handleFiatArrived({
      userId:        deposit.userId,
      currency:      deposit.currency,
      amount:        Number(deposit.amount),
      rail:          'daraja_stk',
      railReference: parsed.mpesaReceiptNumber ?? parsed.checkoutRequestId,
    });
    console.log(`[Daraja STK] Deposit ${deposit.trackingId} confirmed — M-Pesa receipt: ${parsed.mpesaReceiptNumber}`);
  } else {
    await prisma.bankDeposit.update({
      where: { id: deposit.id },
      data: { status: 'FAILED' },
    });
    console.warn(`[Daraja STK] Deposit ${deposit.trackingId} cancelled/failed — ${parsed.failureReason}`);
  }
});

export default router;
