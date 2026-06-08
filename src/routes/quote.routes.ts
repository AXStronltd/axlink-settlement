import { Router, Request, Response } from 'express';
import { createQuote, getQuote, formatQuoteResponse } from '../services/quote.service';
import { SUPPORTED_CURRENCIES } from '../services/fx.service';

const router = Router();

// POST /api/quote — request a JIT rate lock
// Call this BEFORE /api/transfers — user sees the locked rate for 30s
router.post('/', async (req: Request, res: Response) => {
  const { fromCurrency, toCurrency, fromAmount } = req.body as {
    fromCurrency: string;
    toCurrency: string;
    fromAmount: number;
  };

  if (!fromCurrency || !toCurrency || fromAmount === undefined || fromAmount === null) {
    res.status(400).json({ error: 'fromCurrency, toCurrency, fromAmount are required' });
    return;
  }
  if (Number(fromAmount) <= 0) {
    res.status(400).json({ error: 'fromAmount must be greater than 0' });
    return;
  }

  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  if (!SUPPORTED_CURRENCIES.includes(from as typeof SUPPORTED_CURRENCIES[number]) &&
      !['USDT', 'USD'].includes(from)) {
    res.status(400).json({ error: `Unsupported fromCurrency: ${from}` });
    return;
  }

  const quote = await createQuote({ fromCurrency: from, toCurrency: to, fromAmount: Number(fromAmount) });
  res.status(201).json(formatQuoteResponse(quote));
});

// GET /api/quote/:id — check quote status + remaining time
router.get('/:id', (req: Request, res: Response) => {
  const quote = getQuote(String(req.params['id']));
  res.json(formatQuoteResponse(quote));
});

export default router;
