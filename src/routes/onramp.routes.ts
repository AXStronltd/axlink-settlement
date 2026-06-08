import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { createDeposit, getDeposit } from '../services/b2binpay.service';

const router = Router();

// POST /onramp/deposit — generate a deposit address for a user
router.post('/deposit', async (req: Request, res: Response) => {
  const { walletId, userId, currency, confirmationsNeeded } = req.body as {
    walletId: string;
    userId: string;
    currency?: string;
    confirmationsNeeded?: number;
  };

  if (!walletId || !userId) {
    res.status(400).json({ error: 'walletId and userId are required' });
    return;
  }

  const trackingId = `dep_${userId}_${randomUUID()}`;
  const callbackUrl = `${process.env.API_BASE_URL}/webhooks/b2binpay`;

  const deposit = await createDeposit({
    walletId,
    trackingId,
    callbackUrl,
    label: `FinCruse onramp ${currency ?? ''}`.trim(),
    confirmationsNeeded,
  });

  res.status(201).json({
    depositId: deposit.id,
    address: deposit.address,
    trackingId: deposit.tracking_id,
    status: deposit.status,
  });
});

// GET /onramp/deposit/:id — fetch deposit details
router.get('/deposit/:id', async (req: Request, res: Response) => {
  const deposit = await getDeposit(String(req.params['id']));
  res.json(deposit);
});

export default router;
