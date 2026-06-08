import { randomUUID } from 'crypto';
import { prisma, debit, credit, checkSufficientBalance, getUser, audit } from './ledger.service';
import { toUSD, fromUSD, usdToUsdt } from './fx.service';
import { createDeposit, createPayout, calculatePayoutFee } from './b2binpay.service';
import { createTransfer as fbTransfer } from './fireblocks.service';
import { consumeQuote, createQuote, type Quote } from './quote.service';

const CALLBACK_URL = `${process.env.API_BASE_URL}/webhooks/b2binpay`;
const USDT_ASSET = process.env.FIREBLOCKS_USDT_ASSET ?? 'USDT_SOL';
const B2B_WALLET_ID = process.env.B2BINPAY_WALLET_ID ?? '';

// ── Decision logic ────────────────────────────────────────────────────────────

function flowType(fromCurr: string, toCurr: string): '0_b2b' | '2_b2b' {
  const norm = (c: string) => c.toUpperCase();
  return norm(fromCurr) === norm(toCurr) ? '0_b2b' : '2_b2b';
}

// ── Main transfer orchestrator ────────────────────────────────────────────────

export async function executeTransfer(params: {
  senderId: string;
  receiverId: string;
  fromCurrency: string;
  toCurrency: string;
  amount: number;
  note?: string;
  quoteId?: string;   // JIT: if provided, use locked rate — no re-fetch
}) {
  const { senderId, receiverId, fromCurrency, toCurrency, amount, note, quoteId } = params;
  const trackingId = `txn_${randomUUID()}`;

  // 1. Load both users
  const [sender, receiver] = await Promise.all([
    getUser(senderId),
    getUser(receiverId),
  ]);

  // 2. Balance check
  await checkSufficientBalance(senderId, fromCurrency, amount);

  // 3. Resolve amounts — use locked quote if provided, otherwise fetch live rate
  let quote: Quote;
  if (quoteId) {
    // JIT path: consume the pre-locked quote (throws if expired or already used)
    quote = consumeQuote(quoteId);
    if (quote.fromCurrency !== fromCurrency.toUpperCase() ||
        quote.toCurrency !== toCurrency.toUpperCase()) {
      throw new Error('Quote currency mismatch — create a new quote for this pair');
    }
    if (Math.abs(quote.fromAmount - amount) > 0.0001) {
      throw new Error('Quote amount mismatch — create a new quote for this amount');
    }
  } else {
    // Non-JIT fallback: create a spot quote on the fly
    quote = await createQuote({ fromCurrency, toCurrency, fromAmount: amount });
  }

  const { toAmount, usdAmount, usdtAmount, rate: fxRate } = quote;
  const flow = flowType(fromCurrency, toCurrency);

  // 4. Create transfer record
  const transfer = await prisma.transfer.create({
    data: {
      trackingId,
      senderId,
      receiverId,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      usdAmount,
      usdtAmount,
      fxRate,
      note,
      status: 'PROCESSING',
    },
  });

  await audit('Transfer', transfer.id, 'CREATED', { flow, usdAmount, usdtAmount });

  try {
    // 5. Atomic ledger debit
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await debit(tx, senderId, fromCurrency, amount);
    });

    let onrampId: string | undefined;
    let offrampId: string | undefined;
    let fbTxId: string | undefined;

    if (flow === '0_b2b') {
      // ── SAME CURRENCY: 0 B2BinPay, 1 Fireblocks ──────────────────────────
      // USD = USDT 1:1 — just move vaults
      const fbTx = await fbTransfer({
        assetId: USDT_ASSET,
        amount: usdtAmount.toString(),
        sourceVaultId: sender.vaultId,
        destVaultId: receiver.vaultId,
        note: note ?? `FinCruse transfer ${trackingId}`,
        externalTxId: trackingId,
      });
      fbTxId = fbTx?.id as string | undefined;

    } else {
      // ── CROSS-CURRENCY: 2 B2BinPay + 1 Fireblocks ────────────────────────

      // Step A: B2BinPay on-ramp — create deposit for fromCurrency amount
      const deposit = await createDeposit({
        walletId: B2B_WALLET_ID,
        trackingId: `onramp_${trackingId}`,
        callbackUrl: CALLBACK_URL,
        label: `FinCruse onramp ${trackingId}`,
        confirmationsNeeded: 1,
      });
      onrampId = deposit.id;

      // Step B: Fireblocks vault-to-vault (USDT)
      const fbTx = await fbTransfer({
        assetId: USDT_ASSET,
        amount: usdtAmount.toString(),
        sourceVaultId: sender.vaultId,
        destVaultId: receiver.vaultId,
        note: `FinCruse cross-border ${trackingId}`,
        externalTxId: trackingId,
      });
      fbTxId = fbTx?.id as string | undefined;

      // Step C: B2BinPay off-ramp — payout in toCurrency
      const estimate = await calculatePayoutFee({
        walletId: B2B_WALLET_ID,
        address: receiver.vaultId,
        amount: toAmount.toString(),
        currencyId: toCurrency,
      });

      const payout = await createPayout({
        walletId: B2B_WALLET_ID,
        currencyId: toCurrency,
        address: receiver.vaultId,
        amount: toAmount.toString(),
        feeAmount: estimate.fee.medium,
        trackingId: `offramp_${trackingId}`,
        callbackUrl: CALLBACK_URL,
        idempotencyKey: randomUUID(),
        label: `FinCruse offramp ${trackingId}`,
      });
      offrampId = payout.id;
    }

    // 6. Atomic ledger credit
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await credit(tx, receiverId, toCurrency, toAmount);
    });

    // 7. Mark completed
    const completed = await prisma.transfer.update({
      where: { id: transfer.id },
      data: { status: 'COMPLETED', onrampId, offrampId, fbTxId },
    });

    await audit('Transfer', transfer.id, 'STATUS_CHANGED', { status: 'COMPLETED' });
    return completed;

  } catch (err) {
    await prisma.transfer.update({
      where: { id: transfer.id },
      data: { status: 'FAILED' },
    });
    await audit('Transfer', transfer.id, 'ERROR', { error: String(err) });
    throw err;
  }
}

// ── Withdrawal: FinCruse → external bank ─────────────────────────────────────

export async function executeWithdrawal(params: {
  userId: string;
  currency: string;
  amount: number;
  bankAccount: string;
  bankName: string;
  note?: string;
}) {
  const { userId, currency, amount, bankAccount, bankName, note } = params;
  const trackingId = `wdr_${randomUUID()}`;

  const user = await getUser(userId);
  await checkSufficientBalance(userId, currency, amount);

  const usdAmount = await toUSD(amount, currency);
  const usdtAmount = usdToUsdt(usdAmount);

  const withdrawal = await prisma.withdrawal.create({
    data: { trackingId, userId, currency, amount, usdAmount, usdtAmount, bankAccount, bankName, note, status: 'PROCESSING' },
  });

  await audit('Withdrawal', withdrawal.id, 'CREATED', { usdAmount, usdtAmount });

  try {
    // Debit ledger
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await debit(tx, userId, currency, amount);
    });

    // Fireblocks vault debit
    const fbTx = await fbTransfer({
      assetId: USDT_ASSET,
      amount: usdtAmount.toString(),
      sourceVaultId: user.vaultId,
      destAddress: process.env.FIREBLOCKS_SETTLEMENT_ADDRESS ?? bankAccount,
      note: `FinCruse withdrawal ${trackingId}`,
      externalTxId: trackingId,
    });

    // B2BinPay off-ramp: USDT → local fiat
    const estimate = await calculatePayoutFee({
      walletId: B2B_WALLET_ID,
      address: bankAccount,
      amount: amount.toString(),
      currencyId: currency,
    });

    const payout = await createPayout({
      walletId: B2B_WALLET_ID,
      currencyId: currency,
      address: bankAccount,
      amount: amount.toString(),
      feeAmount: estimate.fee.medium,
      trackingId: `offramp_wdr_${trackingId}`,
      callbackUrl: CALLBACK_URL,
      idempotencyKey: randomUUID(),
      label: `FinCruse withdrawal ${trackingId}`,
    });

    const done = await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { status: 'COMPLETED', fbTxId: fbTx?.id as string | undefined, offrampId: payout.id },
    });

    await audit('Withdrawal', withdrawal.id, 'STATUS_CHANGED', { status: 'COMPLETED' });
    return done;

  } catch (err) {
    await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'FAILED' } });
    await audit('Withdrawal', withdrawal.id, 'ERROR', { error: String(err) });
    throw err;
  }
}

// ── Bank deposit: external bank → FinCruse ────────────────────────────────────

export async function executeBankDeposit(params: {
  userId: string;
  currency: string;
  amount: number;
  bankName: string;
  reference?: string;
}) {
  const { userId, currency, amount, bankName, reference } = params;
  const trackingId = `dep_${randomUUID()}`;

  const user = await getUser(userId);
  const usdAmount = await toUSD(amount, currency);
  const usdtAmount = usdToUsdt(usdAmount);

  const deposit = await prisma.bankDeposit.create({
    data: { trackingId, userId, currency, amount, usdAmount, usdtAmount, bankName, reference, status: 'PROCESSING' },
  });

  await audit('BankDeposit', deposit.id, 'CREATED', { usdAmount, usdtAmount });

  try {
    // B2BinPay on-ramp: fiat → USDT
    const b2bDeposit = await createDeposit({
      walletId: B2B_WALLET_ID,
      trackingId: `onramp_dep_${trackingId}`,
      callbackUrl: CALLBACK_URL,
      label: `FinCruse bank deposit ${trackingId}`,
    });

    // Fireblocks credit vault
    const fbTx = await fbTransfer({
      assetId: USDT_ASSET,
      amount: usdtAmount.toString(),
      sourceVaultId: process.env.FIREBLOCKS_TREASURY_VAULT ?? '',
      destVaultId: user.vaultId,
      note: `FinCruse bank deposit ${trackingId}`,
      externalTxId: trackingId,
    });

    // Credit ledger
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await credit(tx, userId, currency, amount);
    });

    const done = await prisma.bankDeposit.update({
      where: { id: deposit.id },
      data: { status: 'COMPLETED', onrampId: b2bDeposit.id, fbTxId: fbTx?.id as string | undefined },
    });

    await audit('BankDeposit', deposit.id, 'STATUS_CHANGED', { status: 'COMPLETED' });
    return done;

  } catch (err) {
    await prisma.bankDeposit.update({ where: { id: deposit.id }, data: { status: 'FAILED' } });
    await audit('BankDeposit', deposit.id, 'ERROR', { error: String(err) });
    throw err;
  }
}

// ── Crypto buy: fiat ledger → user's crypto wallet ────────────────────────────

export async function executeCryptoBuy(params: {
  userId: string;
  fromCurrency: string;
  amount: number;
}) {
  const { userId, fromCurrency, amount } = params;
  const trackingId = `buy_${randomUUID()}`;

  const user = await getUser(userId);
  await checkSufficientBalance(userId, fromCurrency, amount);

  const usdAmount = await toUSD(amount, fromCurrency);
  const usdtAmount = usdToUsdt(usdAmount); // USD = USDT 1:1

  const buy = await prisma.cryptoBuy.create({
    data: { trackingId, userId, fromCurrency, fromAmount: amount, usdtAmount, usdAmount, status: 'PROCESSING' },
  });

  await audit('CryptoBuy', buy.id, 'CREATED', { usdAmount, usdtAmount });

  try {
    // Debit fiat ledger
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await debit(tx, userId, fromCurrency, amount);
    });

    // Internal vault relabel: fiat-vault → crypto-vault (same user, different label)
    // In practice: move USDT between two vaults owned by same user
    const fbTx = await fbTransfer({
      assetId: USDT_ASSET,
      amount: usdtAmount.toString(),
      sourceVaultId: user.vaultId,
      destVaultId: user.vaultId, // same vault — just tracked differently in ledger
      note: `FinCruse crypto buy ${trackingId}`,
      externalTxId: trackingId,
    });

    const done = await prisma.cryptoBuy.update({
      where: { id: buy.id },
      data: { status: 'COMPLETED', fbTxId: fbTx?.id as string | undefined },
    });

    await audit('CryptoBuy', buy.id, 'STATUS_CHANGED', { status: 'COMPLETED' });
    return done;

  } catch (err) {
    await prisma.cryptoBuy.update({ where: { id: buy.id }, data: { status: 'FAILED' } });
    await audit('CryptoBuy', buy.id, 'ERROR', { error: String(err) });
    throw err;
  }
}
