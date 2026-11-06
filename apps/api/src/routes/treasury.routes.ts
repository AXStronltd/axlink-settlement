import { Router, Request, Response } from 'express';
import { rebalanceCorridor, listCorridors } from '../../../../packages/settlement/treasury/treasury.service';

const router = Router();

// All treasury routes require the internal ops key — not the bank API key.
// Set OPS_API_KEY in .env and keep it out of any bank-facing config.
function requireOpsAuth(req: Request, res: Response, next: () => void): void {
  const opsKey = process.env.OPS_API_KEY;
  if (!opsKey) {
    res.status(500).json({ error: 'OPS_API_KEY not configured on this instance', code: 'MISCONFIGURED' });
    return;
  }
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.slice(7).trim() !== opsKey) {
    res.status(401).json({ error: 'Ops authentication required', code: 'UNAUTHORIZED' });
    return;
  }
  next();
}

// GET /api/ops/corridors — list configured corridors and their status
router.get('/corridors', requireOpsAuth, (_req: Request, res: Response) => {
  res.json({ corridors: listCorridors() });
});

// POST /api/ops/rebalance — push fiat into a corridor float
// Body: { currency: "KES", amount: 500000 }
router.post('/rebalance', requireOpsAuth, async (req: Request, res: Response): Promise<void> => {
  const { currency, amount } = req.body as { currency: string; amount: number };

  if (!currency || !amount || typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: 'currency and a positive amount are required', code: 'VALIDATION_ERROR' });
    return;
  }

  const result = await rebalanceCorridor({
    currency,
    amount,
    operatorId: 'ops-api',
  });

  res.status(201).json({
    ...result,
    message: `${result.fiatAmount} ${result.currency} corridor float top-up initiated via ${result.provider}. USDT stays internal until B2BinPay confirms.`,
  });
});

export default router;
