import { Router, Request, Response } from 'express';
import { protectCustomerApi } from '../../../../packages/core/tenancy/customer-auth.middleware';
import { initiateDeposit, getDepositStatus, listUserDeposits, getAvailableMethods } from '../../../../packages/settlement/deposits/deposit.service';
import type { DepositMethod } from '../../../../packages/providers/banking/brainrock/brainrock';

const router = Router();
// F4: operator or institution credential required; institutions are confined to their own customers.
router.use(...protectCustomerApi);

// GET /api/deposits/methods?currency=GBP
// Returns which payment methods are available for a given currency.
// Frontend calls this when user picks their currency to show the right buttons.
router.get('/methods', (_req: Request, res: Response) => {
  const currency = String(_req.query.currency ?? '').toUpperCase();
  if (!currency) {
    res.status(400).json({ error: 'currency is required', code: 'VALIDATION_ERROR' });
    return;
  }
  const methods = getAvailableMethods(currency);
  res.json({
    currency,
    methods,
    available: methods.length > 0,
  });
});

// POST /api/deposits/initiate
// User clicks "Add Funds" → picks Apple Pay / Google Pay / Open Banking → this fires.
// Returns checkoutUrl (Open Banking) or clientToken (Apple/Google Pay SDK).
router.post('/initiate', async (req: Request, res: Response): Promise<void> => {
  const { userId, currency, amount, method } = req.body as {
    userId:   string;
    currency: string;
    amount:   number;
    method:   DepositMethod;
  };

  if (!userId || !currency || !amount || !method) {
    res.status(400).json({
      error: 'userId, currency, amount, and method are required',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  if (typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: 'amount must be a positive number', code: 'VALIDATION_ERROR' });
    return;
  }

  const VALID_METHODS: DepositMethod[] = ['apple_pay', 'google_pay', 'open_banking', 'bank_transfer'];
  if (!VALID_METHODS.includes(method)) {
    res.status(400).json({
      error: `method must be one of: ${VALID_METHODS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  const result = await initiateDeposit({ userId, currency, amount, method });
  res.status(201).json(result);
});

// GET /api/deposits/:id?userId=xxx
// Frontend polls this after initiating a deposit to show live status.
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const depositId = req.params['id'] as string;
  const userId    = String(req.query.userId ?? '');

  if (!userId) {
    res.status(400).json({ error: 'userId query param is required', code: 'VALIDATION_ERROR' });
    return;
  }

  const result = await getDepositStatus(depositId, userId);
  res.json(result);
});

// GET /api/deposits?userId=xxx&limit=20
// Returns recent deposits for a user — shown in their transaction history.
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = String(req.query.userId ?? '');
  const limit  = parseInt(String(req.query.limit ?? '20'), 10);

  if (!userId) {
    res.status(400).json({ error: 'userId query param is required', code: 'VALIDATION_ERROR' });
    return;
  }

  const deposits = await listUserDeposits(userId, isNaN(limit) ? 20 : limit);
  res.json({ deposits, total: deposits.length });
});

export default router;
