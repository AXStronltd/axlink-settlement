import { Router, Request, Response } from 'express';
import { verifyWebhookSignature, buildAuthDecision } from '../providers/live/brainrock';
import { prisma, credit, debit, getBalance } from '../core/ledger.service';
import { handleFiatArrived } from '../core/orchestrator.service';
import { confirmWithdrawalFromPartner, reverseWithdrawalFromPartner } from '../core/settlement/payout-confirmation.service';
import { getRate } from '../core/fx.service';

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

  // ── Inbound: fiat arrived — two paths ────────────────────────────────────
  //
  //  Path A (user-initiated Add Funds):
  //    data.reference = trackingId (dep_xxx) set when we created the session
  //    → look up BankDeposit by sessionId / reference → get userId from there
  //
  //  Path B (push: user sent money to their virtual IBAN manually):
  //    data.accountId = Brainrock virtual account ID mapped to a user
  //    → look up user by brainrockAccountId
  //
  if (type === 'payment.received' && data.amount && data.currency) {
    let userId: string | null = null;
    let existingDepositId: string | undefined;
    let railReference = data.paymentId ?? data.reference ?? 'brainrock_unknown';

    // Path A — session-initiated deposit (Add Funds flow)
    if (data.reference) {
      const pending = await prisma.bankDeposit.findFirst({
        where: {
          OR: [
            { sessionId: data.reference },
            { trackingId: data.reference },
          ],
          status: 'AWAITING_PAYMENT',
        },
      });
      if (pending) {
        userId = pending.userId;
        existingDepositId = pending.id;
        console.log(`[Brainrock] Session deposit matched: trackingId=${pending.trackingId} userId=${userId}`);
      }
    }

    // Path B — virtual IBAN push (existing flow)
    if (!userId && data.accountId) {
      const user = await prisma.user.findFirst({ where: { brainrockAccountId: data.accountId } });
      if (user) userId = user.id;
    }

    if (!userId) {
      console.warn(`[Brainrock] payment.received — no matching user for reference=${data.reference ?? '-'} accountId=${data.accountId ?? '-'}`);
      res.status(200).json({ received: true });
      return;
    }

    // Full deposit: B2BinPay on-ramp → USDT → Fireblocks → ledger credit
    await handleFiatArrived({
      userId,
      currency: data.currency,
      amount:   data.amount,
      rail:     'brainrock',
      railReference,
      existingDepositId,
    });
  }

  // ── Outbound confirmed: fiat reached user's bank/M-Pesa ─────────────────
  // Goes through the settlement engine so the PARTNER_PAYOUT leg is confirmed
  // and suspense is cleared. Writing `status: COMPLETED` here directly would
  // leave the money in SUSPENSE:USD on the books.
  if (type === 'payment.sent' && data.paymentId) {
    const withdrawal = await prisma.withdrawal.findFirst({
      where: { brainrockPaymentId: data.paymentId },
    });
    if (withdrawal) {
      await confirmWithdrawalFromPartner({
        withdrawalId:     withdrawal.id,
        partnerReference: data.paymentId,
        providerId:       'brainrock',
      });
    } else {
      console.warn(`[Brainrock] payment.sent — no withdrawal for paymentId=${data.paymentId}`);
    }
  }

  // ── Outbound failed: reverse ledger debit ────────────────────────────────
  if (type === 'payment.failed' && data.paymentId) {
    const withdrawal = await prisma.withdrawal.findFirst({
      where: { brainrockPaymentId: data.paymentId, status: 'PENDING_PAYOUT' },
    });
    if (withdrawal) {
      // Through the settlement engine so the reversal reaches the journal, not
      // just the balance projection. Crediting the projection alone left the
      // books holding the money in SUSPENSE while the customer had it back.
      await reverseWithdrawalFromPartner({
        withdrawalId: withdrawal.id,
        reason:       data.failureReason ?? 'unknown reason',
        providerId:   'brainrock',
      });
    }
  }

  res.status(200).json({ received: true });
});

// ── Card authorization (real-time — Visa/MC requires response in <100ms) ─────
// Brainrock posts here the moment a user taps/swipes their card.
// AxLink checks balance, debits, and returns approve/decline synchronously.
router.post('/brainrock/card/authorize', async (req: Request, res: Response) => {
  const signature = (req.headers['x-brainrock-signature'] as string | undefined) ?? '';
  const rawBody   = (req as Request & { rawBody?: string }).rawBody ?? '';

  const secretConfigured = (process.env.BRAINROCK_WEBHOOK_SECRET ?? '').length > 0;
  if (secretConfigured && !verifyWebhookSignature(rawBody, signature)) {
    res.status(401).json(buildAuthDecision(false, '', 'Invalid signature'));
    return;
  }

  const t0 = Date.now();

  const event = req.body as {
    authorization_id: string;
    card_id:          string;       // Brainrock providerCardId
    amount:           number;       // amount at POS
    currency:         string;       // currency at POS (e.g. GBP at UK merchant)
    merchant_name?:   string;
    merchant_category?: string;
  };

  const { authorization_id, card_id, amount, currency, merchant_name, merchant_category } = event;

  try {
    // 1. Find card + user
    const card = await prisma.card.findUnique({
      where: { providerCardId: card_id },
      include: { user: true },
    });

    if (!card) {
      console.warn(`[Card Auth] Unknown card ${card_id} — declined`);
      res.json(buildAuthDecision(false, authorization_id, 'Card not found'));
      return;
    }

    if (card.status !== 'ACTIVE') {
      console.warn(`[Card Auth] Card ${card_id} is ${card.status} — declined`);
      res.json(buildAuthDecision(false, authorization_id, `Card is ${card.status.toLowerCase()}`));
      return;
    }

    // 2. Determine debit currency and amount
    // If card currency matches POS currency → no FX. Otherwise convert via AxLink rate.
    const spendCcy  = currency.toUpperCase();
    const debitCcy  = card.currency.toUpperCase();
    let   debitAmt  = amount;
    let   fxRate    = 1;

    if (spendCcy !== debitCcy) {
      fxRate   = await getRate(spendCcy, debitCcy);
      debitAmt = parseFloat((amount * fxRate).toFixed(8));
    }

    // 3. Check balance (fast path — single DB read)
    const balance = await getBalance(card.userId, debitCcy);
    if (balance < debitAmt) {
      const auth = await prisma.cardAuthorization.create({
        data: {
          cardId: card.id, userId: card.userId,
          providerAuthId: authorization_id,
          amount: amount, spendCurrency: spendCcy,
          debitAmount: debitAmt, debitCurrency: debitCcy,
          fxRate: fxRate !== 1 ? fxRate : null,
          merchantName: merchant_name, merchantCategory: merchant_category,
          status: 'DECLINED', declineReason: 'Insufficient balance',
        },
      });
      console.log(`[Card Auth] DECLINED ${card.user.name} ${amount} ${spendCcy} — insufficient balance (${Date.now() - t0}ms)`);
      res.json(buildAuthDecision(false, authorization_id, 'Insufficient balance'));
      return;
    }

    // 4. Debit ledger immediately (Monzo pattern — debit on auth, credit on reversal)
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await debit(tx, card.userId, debitCcy, debitAmt);
    });

    // 5. Record authorization
    await prisma.cardAuthorization.create({
      data: {
        cardId: card.id, userId: card.userId,
        providerAuthId: authorization_id,
        amount: amount, spendCurrency: spendCcy,
        debitAmount: debitAmt, debitCurrency: debitCcy,
        fxRate: fxRate !== 1 ? fxRate : null,
        merchantName: merchant_name, merchantCategory: merchant_category,
        status: 'APPROVED',
      },
    });

    console.log(`[Card Auth] APPROVED ${card.user.name} ${amount} ${spendCcy}${spendCcy !== debitCcy ? ` → ${debitAmt.toFixed(2)} ${debitCcy} @ ${fxRate}` : ''} (${Date.now() - t0}ms)`);
    res.json(buildAuthDecision(true, authorization_id));

  } catch (err) {
    // Never let an exception leave the user hanging — decline with internal error
    console.error('[Card Auth] Error — declining to be safe:', err);
    res.json(buildAuthDecision(false, authorization_id, 'Internal error'));
  }
});

// ── Card transaction settled ──────────────────────────────────────────────────
// Brainrock fires this once the transaction clears (typically T+1).
// Ledger is already debited from authorization — this is a status update only.
router.post('/brainrock/card/settled', async (req: Request, res: Response) => {
  const { authorization_id } = req.body as { authorization_id: string };

  if (authorization_id) {
    await prisma.cardAuthorization.updateMany({
      where:  { providerAuthId: authorization_id, status: 'APPROVED' },
      data:   { status: 'SETTLED' },
    });
    console.log(`[Card] Settled authorization ${authorization_id}`);
  }

  res.json({ received: true });
});

// ── Card transaction reversed ─────────────────────────────────────────────────
// Merchant reversal, chargeback, or auth timeout → credit user back.
router.post('/brainrock/card/reversed', async (req: Request, res: Response) => {
  const { authorization_id, reason } = req.body as { authorization_id: string; reason?: string };

  const auth = await prisma.cardAuthorization.findUnique({ where: { providerAuthId: authorization_id } });

  if (auth && auth.status === 'APPROVED') {
    await prisma.$transaction(async (tx: Parameters<typeof credit>[0]) => {
      await credit(tx, auth.userId, auth.debitCurrency, Number(auth.debitAmount));
    });
    await prisma.cardAuthorization.update({
      where: { providerAuthId: authorization_id },
      data:  { status: 'REVERSED' },
    });
    console.log(`[Card] Reversed ${Number(auth.debitAmount).toFixed(2)} ${auth.debitCurrency} for auth ${authorization_id} — ${reason ?? 'no reason given'}`);
  }

  res.json({ received: true });
});

export default router;
