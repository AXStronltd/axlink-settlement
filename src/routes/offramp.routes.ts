import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  calculatePayoutFee,
  createPayout,
  getPayout,
} from '../services/b2binpay.service';

const router = Router();

// POST /offramp/estimate — calculate fees before committing to payout
router.post('/estimate', async (req: Request, res: Response) => {
  const { walletId, address, amount, currencyId } = req.body as {
    walletId: string;
    address: string;
    amount: string;
    currencyId: string;
  };

  if (!walletId || !address || !amount || !currencyId) {
    res.status(400).json({ error: 'walletId, address, amount, currencyId are required' });
    return;
  }

  const estimate = await calculatePayoutFee({ walletId, address, amount, currencyId });

  res.json({
    isInternal: estimate.is_internal,
    fee: estimate.fee,
    warning: estimate.warning,
  });
});

// POST /offramp/payout — initiate a payout (offramp)
router.post('/payout', async (req: Request, res: Response) => {
  const {
    walletId,
    currencyId,
    address,
    amount,
    feeAmount,
    userId,
    feeSpeed = 'medium',
    confirmationsNeeded,
  } = req.body as {
    walletId: string;
    currencyId: string;
    address: string;
    amount: string;
    feeAmount?: string;
    userId: string;
    feeSpeed?: 'low' | 'medium' | 'high';
    confirmationsNeeded?: number;
  };

  if (!walletId || !currencyId || !address || !amount || !userId) {
    res.status(400).json({ error: 'walletId, currencyId, address, amount, userId are required' });
    return;
  }

  // If feeAmount not provided, auto-estimate using requested feeSpeed
  let resolvedFee = feeAmount;
  if (!resolvedFee) {
    const estimate = await calculatePayoutFee({ walletId, address, amount, currencyId });
    resolvedFee = estimate.fee[feeSpeed];
  }

  const trackingId = `pay_${userId}_${randomUUID()}`;
  const callbackUrl = `${process.env.API_BASE_URL}/webhooks/b2binpay`;
  const idempotencyKey = randomUUID();

  const payout = await createPayout({
    walletId,
    currencyId,
    address,
    amount,
    feeAmount: resolvedFee,
    trackingId,
    callbackUrl,
    idempotencyKey,
    label: `FinCruse offramp`,
    confirmationsNeeded,
  });

  res.status(201).json({
    payoutId: payout.id,
    trackingId: payout.tracking_id,
    status: payout.status,
    amount: payout.amount,
    feeAmount: payout.fee_amount,
  });
});

// GET /offramp/payout/:id — fetch payout details
router.get('/payout/:id', async (req: Request, res: Response) => {
  const payout = await getPayout(String(req.params['id']));
  res.json(payout);
});

export default router;
