import { Router, Request, Response } from 'express';
import { executeTransfer, executeWithdrawal, executeBankDeposit, executeCryptoBuy } from '../services/transfer.service';
import { prisma, getUser, createUser, getBalance } from '../services/ledger.service';
import { createVaultAccount } from '../services/fireblocks.service';
import { SUPPORTED_CURRENCIES } from '../services/fx.service';

const router = Router();

// ── Users ─────────────────────────────────────────────────────────────────────

// POST /api/users — create a user + Fireblocks vault + ledger account
router.post('/users', async (req: Request, res: Response) => {
  const { email, name, currency } = req.body as {
    email: string; name: string; currency: string;
  };
  if (!email || !name || !currency) {
    res.status(400).json({ error: 'email, name, currency are required' });
    return;
  }
  if (!SUPPORTED_CURRENCIES.includes(currency as typeof SUPPORTED_CURRENCIES[number])) {
    res.status(400).json({ error: `Unsupported currency. Supported: ${SUPPORTED_CURRENCIES.join(', ')}` });
    return;
  }

  // Create Fireblocks vault first
  const vault = await createVaultAccount(`fincruise_${email}`, true);
  const vaultId = (vault as { id?: string })?.id ?? '';

  const user = await createUser({ email, name, vaultId, currency });
  res.status(201).json({ userId: user.id, vaultId, currency });
});

// GET /api/users/:id — get user + balances
router.get('/users/:id', async (req: Request, res: Response) => {
  const user = await getUser(String(req.params['id']));
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    kycStatus: user.kycStatus,
    accounts: user.accounts.map((a: { currency: string; balance: { toString: () => string }; balanceUsd: { toString: () => string } }) => ({
      currency: a.currency,
      balance: Number(a.balance),
      balanceUsd: Number(a.balanceUsd),
    })),
  });
});

// GET /api/users/:id/balance/:currency
router.get('/users/:id/balance/:currency', async (req: Request, res: Response) => {
  const balance = await getBalance(
    String(req.params['id']),
    String(req.params['currency']).toUpperCase(),
  );
  res.json({ balance, currency: String(req.params['currency']).toUpperCase() });
});

// ── Transfers (user → user) ───────────────────────────────────────────────────

// POST /api/transfers — main orchestrator endpoint
router.post('/transfers', async (req: Request, res: Response) => {
  const { senderId, receiverId, fromCurrency, toCurrency, amount, note, quoteId } = req.body as {
    senderId: string;
    receiverId: string;
    fromCurrency: string;
    toCurrency: string;
    amount: number;
    note?: string;
    quoteId?: string;  // JIT: pass the locked quoteId from POST /api/quote
  };

  if (!senderId || !receiverId || !fromCurrency || !toCurrency) {
    res.status(400).json({ error: 'senderId, receiverId, fromCurrency, toCurrency, amount are required' });
    return;
  }
  if (!amount || amount <= 0) {
    res.status(400).json({ error: 'amount must be greater than 0' });
    return;
  }
  if (senderId === receiverId) {
    res.status(400).json({ error: 'sender and receiver cannot be the same user' });
    return;
  }

  const sameCurrency = fromCurrency.toUpperCase() === toCurrency.toUpperCase();
  const transfer = await executeTransfer({ senderId, receiverId, fromCurrency, toCurrency, amount, note, quoteId });

  res.status(201).json({
    transferId: transfer.id,
    trackingId: transfer.trackingId,
    status: transfer.status,
    jit: !!quoteId,
    quoteId: quoteId ?? null,
    fromCurrency,
    toCurrency,
    fromAmount: Number(transfer.fromAmount),
    toAmount: Number(transfer.toAmount),
    usdAmount: Number(transfer.usdAmount),
    fxRate: Number(transfer.fxRate),
    flow: sameCurrency ? '0 B2BinPay — same currency' : '2 B2BinPay — cross-currency (JIT)',
    fireblocksTxId: transfer.fbTxId,
    b2binpay: {
      onrampId: transfer.onrampId ?? null,
      offrampId: transfer.offrampId ?? null,
    },
  });
});

// GET /api/transfers/:id
router.get('/transfers/:id', async (req: Request, res: Response) => {
  const transfer = await prisma.transfer.findUniqueOrThrow({
    where: { id: String(req.params['id']) },
  });
  res.json(transfer);
});

// ── Withdrawals (FinCruse → bank) ─────────────────────────────────────────────

// POST /api/withdrawals
router.post('/withdrawals', async (req: Request, res: Response) => {
  const { userId, currency, amount, bankAccount, bankName, note } = req.body as {
    userId: string;
    currency: string;
    amount: number;
    bankAccount: string;
    bankName: string;
    note?: string;
  };

  if (!userId || !currency || !amount || !bankAccount || !bankName) {
    res.status(400).json({ error: 'userId, currency, amount, bankAccount, bankName are required' });
    return;
  }

  const withdrawal = await executeWithdrawal({ userId, currency, amount, bankAccount, bankName, note });

  res.status(201).json({
    withdrawalId: withdrawal.id,
    trackingId: withdrawal.trackingId,
    status: withdrawal.status,
    currency: withdrawal.currency,
    amount: Number(withdrawal.amount),
    usdAmount: Number(withdrawal.usdAmount),
    flow: '1 B2BinPay off-ramp — fiat exits FinCruse',
    fireblocksTxId: withdrawal.fbTxId,
    offrampId: withdrawal.offrampId,
  });
});

// GET /api/withdrawals/:id
router.get('/withdrawals/:id', async (req: Request, res: Response) => {
  const w = await prisma.withdrawal.findUniqueOrThrow({
    where: { id: String(req.params['id']) },
  });
  res.json(w);
});

// ── Bank deposits (external bank → FinCruse) ──────────────────────────────────

// POST /api/deposits/bank
router.post('/deposits/bank', async (req: Request, res: Response) => {
  const { userId, currency, amount, bankName, reference } = req.body as {
    userId: string;
    currency: string;
    amount: number;
    bankName: string;
    reference?: string;
  };

  if (!userId || !currency || !amount || !bankName) {
    res.status(400).json({ error: 'userId, currency, amount, bankName are required' });
    return;
  }

  const deposit = await executeBankDeposit({ userId, currency, amount, bankName, reference });

  res.status(201).json({
    depositId: deposit.id,
    trackingId: deposit.trackingId,
    status: deposit.status,
    currency: deposit.currency,
    amount: Number(deposit.amount),
    usdAmount: Number(deposit.usdAmount),
    flow: '1 B2BinPay on-ramp — fiat enters FinCruse',
    fireblocksTxId: deposit.fbTxId,
    onrampId: deposit.onrampId,
  });
});

// GET /api/deposits/:id
router.get('/deposits/:id', async (req: Request, res: Response) => {
  const d = await prisma.bankDeposit.findUniqueOrThrow({
    where: { id: String(req.params['id']) },
  });
  res.json(d);
});

// ── Crypto buy (user-initiated) ───────────────────────────────────────────────

// POST /api/crypto/buy
router.post('/crypto/buy', async (req: Request, res: Response) => {
  const { userId, fromCurrency, amount } = req.body as {
    userId: string;
    fromCurrency: string;
    amount: number;
  };

  if (!userId || !fromCurrency || !amount) {
    res.status(400).json({ error: 'userId, fromCurrency, amount are required' });
    return;
  }

  const buy = await executeCryptoBuy({ userId, fromCurrency, amount });

  res.status(201).json({
    buyId: buy.id,
    trackingId: buy.trackingId,
    status: buy.status,
    fromCurrency: buy.fromCurrency,
    fromAmount: Number(buy.fromAmount),
    usdtAmount: Number(buy.usdtAmount),
    flow: '0 B2BinPay — USD=USDT 1:1, internal vault move',
    fireblocksTxId: buy.fbTxId,
  });
});

export default router;
