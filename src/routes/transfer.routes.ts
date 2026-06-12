import { Router, Request, Response } from 'express';
import { executeTransfer, executeWithdrawal, executeBankDeposit, executeCryptoBuy } from '../services/transfer.service';
import { prisma, getUser, createUser, getBalance } from '../services/ledger.service';
import { createVaultAccount } from '../services/fireblocks.service';
import { createVirtualAccount, issueCard } from '../services/brainrock.service';
import { SUPPORTED_CURRENCIES } from '../services/fx.service';

const CURRENCY_COUNTRY: Record<string, string> = {
  GBP: 'GB', EUR: 'DE', USD: 'US', KES: 'KE',
  NGN: 'NG', GHS: 'GH', ZAR: 'ZA', UGX: 'UG', TZS: 'TZ',
};

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

  // Provision Fireblocks vault + Brainrock virtual IBAN in parallel
  const [vault, virtualAccount] = await Promise.all([
    createVaultAccount(`fincruise_${email}`, true),
    createVirtualAccount({
      userId: email,
      currency,
      country: CURRENCY_COUNTRY[currency] ?? 'GB',
    }).catch(() => null), // non-fatal — can be provisioned later
  ]);

  const vaultId = (vault as { id?: string })?.id ?? '';

  const user = await createUser({ email, name, vaultId, currency });

  // Persist Brainrock virtual account details
  if (virtualAccount) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        brainrockAccountId: virtualAccount.id,
        virtualIban:        virtualAccount.iban,
        virtualIbanBic:     virtualAccount.bic,
      },
    });
  }

  res.status(201).json({
    userId:      user.id,
    vaultId,
    currency,
    depositAccount: virtualAccount
      ? { iban: virtualAccount.iban, bic: virtualAccount.bic, currency }
      : null,
  });
});

// GET /api/users/lookup?email= — find user by email for P2P send flow
router.get('/users/lookup', async (req: Request, res: Response) => {
  const email = String(req.query['email'] ?? '').trim().toLowerCase();
  if (!email) { res.status(400).json({ error: 'email is required' }); return; }
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    include: { accounts: { select: { currency: true } } },
  });
  if (!user) { res.status(404).json({ error: 'User not found on FinCruse' }); return; }
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    currency: (user.accounts as { currency: string }[])[0]?.currency ?? 'USD',
  });
});

// GET /api/users/:id — get user + balances
router.get('/users/:id', async (req: Request, res: Response) => {
  const user = await getUser(String(req.params['id']));
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    kycStatus: user.kycStatus,
    vaultId: user.vaultId ?? null,
    virtualIban: user.virtualIban ?? null,
    virtualIbanBic: user.virtualIbanBic ?? null,
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

// POST /api/users/:id/card — issue a debit card via Brainrock (or configured card provider)
router.post('/users/:id/card', async (req: Request, res: Response) => {
  const userId = String(req.params['id']);
  const { cardType = 'virtual' } = req.body as { cardType?: 'virtual' | 'physical' };

  const user = await getUser(userId);
  if (user.kycStatus !== 'APPROVED') {
    res.status(403).json({ error: 'KYC must be approved before issuing a card' });
    return;
  }

  const existing = await prisma.card.findFirst({ where: { userId, status: { in: ['ACTIVE', 'FROZEN'] } } });
  if (existing) {
    res.status(409).json({ error: 'User already has an active card', cardId: existing.id, last4: existing.last4 });
    return;
  }

  // Primary account currency drives the card debit currency
  const primaryAccount = user.accounts[0];
  if (!primaryAccount) {
    res.status(400).json({ error: 'User has no account — create an account first' });
    return;
  }

  const providerCard = await issueCard({
    userId,
    currency:       primaryAccount.currency,
    cardType,
    cardholderName: user.name,
  });

  const card = await prisma.card.create({
    data: {
      userId,
      providerCardId: providerCard.id,
      last4:          providerCard.last4,
      brand:          providerCard.brand,
      cardType:       providerCard.cardType,
      currency:       providerCard.currency,
      status:         'ACTIVE',
    },
  });

  console.log(`[Card] Issued ${card.brand} *${card.last4} (${card.cardType}) to ${user.name} — spending currency: ${card.currency}`);

  res.status(201).json({
    cardId:   card.id,
    last4:    card.last4,
    brand:    card.brand,
    cardType: card.cardType,
    currency: card.currency,
    status:   card.status,
    message:  `${card.brand.charAt(0).toUpperCase() + card.brand.slice(1)} debit card issued. Spend anywhere ${card.brand === 'visa' ? 'Visa' : 'Mastercard'} is accepted.`,
  });
});

// GET /api/users/:id/cards — list cards for a user
router.get('/users/:id/cards', async (req: Request, res: Response) => {
  const userId = String(req.params['id']);
  const cards  = await prisma.card.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  res.json({ cards });
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
