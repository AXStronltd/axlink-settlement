import { Router, Request, Response } from 'express';
import {
  handleFiatArrived,
  handleWithdrawalRequest,
  handleP2PTransfer,
  handlePayoutRailConfirmed,
} from '../core/orchestrator.service';
import type { PaymentDestination } from '../providers/live/brainrock';

const router = Router();

// ── Payout Rail Webhook ───────────────────────────────────────────────────────
// M-Pesa / bank partner POSTs here when fiat arrives at AxLink's account
// This triggers the full: on-ramp → Fireblocks → ledger credit flow
router.post('/payout-rail/fiat-arrived', async (req: Request, res: Response) => {
  const { userId, currency, amount, rail, railReference } = req.body as {
    userId: string;
    currency: string;
    amount: number;
    rail: string;
    railReference: string;
  };

  if (!userId || !currency || !amount || !rail || !railReference) {
    res.status(400).json({ error: 'userId, currency, amount, rail, railReference are required' });
    return;
  }

  console.log(`[Orchestrator] Fiat arrived: ${amount} ${currency} via ${rail} (ref: ${railReference}) for user ${userId}`);

  const deposit = await handleFiatArrived({ userId, currency, amount, rail, railReference });

  res.status(201).json({
    depositId: deposit.id,
    trackingId: deposit.trackingId,
    status: deposit.status,
    flow: `${rail} → B2BinPay on-ramp → Fireblocks vault → Ledger credit`,
    message: `${amount} ${currency} received. User balance updated.`,
  });
});

// ── Payout Rail Confirmation ─────────────────────────────────────────────────
// M-Pesa / bank confirms fiat reached the end user after withdrawal
router.post('/payout-rail/confirmed', async (req: Request, res: Response) => {
  const { trackingId, railReference, status, amount, currency } = req.body as {
    trackingId: string;
    railReference: string;
    status: 'SUCCESS' | 'FAILED';
    amount?: number;
    currency?: string;
  };

  if (!trackingId || !railReference || !status) {
    res.status(400).json({ error: 'trackingId, railReference, status are required' });
    return;
  }

  await handlePayoutRailConfirmed({ trackingId, railReference, status, amount, currency });

  res.json({ received: true, status });
});

// ── Withdrawal Request ────────────────────────────────────────────────────────
// User requests to withdraw fiat to their bank/M-Pesa
// destination.type is auto-resolved if not provided
router.post('/withdraw', async (req: Request, res: Response) => {
  const { userId, currency, amount, recipientName, destination } = req.body as {
    userId: string;
    currency: string;
    amount: number;
    recipientName: string;
    destination: PaymentDestination;
  };

  if (!userId || !currency || !amount || !destination || !recipientName) {
    res.status(400).json({
      error: 'userId, currency, amount, recipientName, destination are required',
      example: {
        userId: 'user_id',
        currency: 'KES',
        amount: 10000,
        recipientName: 'James Mwangi',
        destination: { type: 'mpesa', mobileNumber: '+254712345678' },
      },
    });
    return;
  }

  const withdrawal = await handleWithdrawalRequest({
    userId, currency, amount, recipientName, destination,
  });

  res.status(201).json({
    withdrawalId: withdrawal.id,
    trackingId: withdrawal.trackingId,
    status: withdrawal.status,
    flow: `Ledger debit → Fireblocks vault → B2BinPay off-ramp → Brainrock → ${destination.type}`,
    message: `Withdrawal of ${amount} ${currency} initiated to ${destination.type}`,
  });
});

// ── P2P Transfer ──────────────────────────────────────────────────────────────
// User sends money to another AxLink user (replaces old /api/transfers)
router.post('/transfer', async (req: Request, res: Response) => {
  const { senderId, receiverId, fromCurrency, toCurrency, amount, quoteId, note } = req.body as {
    senderId: string;
    receiverId: string;
    fromCurrency: string;
    toCurrency: string;
    amount: number;
    quoteId?: string;
    note?: string;
  };

  if (!senderId || !receiverId || !fromCurrency || !toCurrency || !amount) {
    res.status(400).json({ error: 'senderId, receiverId, fromCurrency, toCurrency, amount are required' });
    return;
  }
  if (senderId === receiverId) {
    res.status(400).json({ error: 'sender and receiver cannot be the same' });
    return;
  }
  if (amount <= 0) {
    res.status(400).json({ error: 'amount must be greater than 0' });
    return;
  }

  const sameCurrency = fromCurrency.toUpperCase() === toCurrency.toUpperCase();
  console.log(`[Orchestrator] P2P ${fromCurrency}→${toCurrency} ${amount} | ${sameCurrency ? '0 B2BinPay' : '2 B2BinPay'}`);

  const transfer = await handleP2PTransfer({
    senderId, receiverId, fromCurrency, toCurrency, amount, quoteId, note,
  });

  res.status(201).json({
    transferId: transfer.id,
    trackingId: transfer.trackingId,
    status: transfer.status,
    jit: !!quoteId,
    flow: sameCurrency
      ? 'Ledger debit → Fireblocks vault → Ledger credit (0 B2BinPay)'
      : 'Ledger debit → B2BinPay on-ramp → Fireblocks → B2BinPay off-ramp → Ledger credit',
    fromAmount: Number(transfer.fromAmount),
    toAmount: Number(transfer.toAmount),
    fxRate: Number(transfer.fxRate),
    b2binpayCalls: sameCurrency ? 0 : 2,
    fireblocksCalls: 1,
  });
});

export default router;
