import { Router, Request, Response } from 'express';
import { getRates } from '../services/b2binpay.service';

const router = Router();

// GET /rates?symbols=BTC,USDT
router.get('/', async (req: Request, res: Response) => {
  const symbols = (req.query.symbols as string | undefined) ?? 'USDT';
  const left = symbols.split(',').map(s => s.trim()).filter(Boolean);

  if (left.length === 0) {
    res.status(400).json({ error: 'symbols query param required (e.g. ?symbols=BTC,USDT)' });
    return;
  }

  const data = await getRates(left);
  res.json(data);
});

export default router;
