/**
 * FinCruse Orchestrator
 *
 * Each user account is permanently paired:
 *   user.b2bWalletId  = their B2BinPay wallet (receives fiat on-ramp)
 *   user.vaultId      = their Fireblocks vault (holds USDT)
 *   user.usdtAddress  = their Fireblocks USDT_SOL deposit address
 *
 * Deposit flow (FIAT IN):
 *   Payout rail → FinCruse webhook
 *   → B2BinPay: convert fiat → USDT, send DIRECTLY to user.usdtAddress (Fireblocks)
 *   → Fireblocks receives USDT → webhook to FinCruse
 *   → FinCruse credits user ledger
 *   NO treasury vault hop. B2BinPay → Fireblocks user vault in one shot.
 *
 * Withdrawal flow (FIAT OUT):
 *   FinCruse debit ledger → Fireblocks send USDT → B2BinPay off-ramp → Payout rail
 *
 * P2P Transfer:
 *   Ledger debit → [B2BinPay on-ramp if cross-currency] → Fireblocks vault-to-vault
 *   → [B2BinPay off-ramp if cross-currency] → Ledger credit
 */

import { randomUUID } from 'crypto';
import { prisma, debit, credit, checkSufficientBalance, getUser, audit } from './ledger.service';
import { toUSD, usdToUsdt, fromUSD } from './fx.service';
import { createDeposit, createPayout, calculatePayoutFee } from './b2binpay.service';
import { createTransfer as fbTransfer } from './fireblocks.service';
import { consumeQuote, createQuote } from './quote.service';

const USDT_ASSET = process.env.FIREBLOCKS_USDT_ASSET ?? 'USDT_SOL';
const B2B_WALLET_ID = process.env.B2BINPAY_WALLET_ID ?? '';
const TREASURY_VAULT = process.env.FIREBLOCKS_TREASURY_VAULT ?? '';
const CALLBACK = `${process.env.API_BASE_URL}/webhooks/b2binpay`;

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 of every deposit: Payout rail tells us fiat arrived
// Called by webhook from M-Pesa / bank partner
// ─────────────────────────────────────────────────────────────────────────────

export async function handleFiatArrived(event: {
  userId: string;
  currency: string;       // KES, GBP, NGN, etc.
  amount: number;         // fiat amount received
  rail: string;           // "mpesa" | "rtgs" | "bank_transfer" | "sepa"
  railReference: string;  // M-Pesa transaction ID, bank ref, etc.
}) {
  const { userId, currency, amount, rail, railReference } = event;
  const trackingId = `dep_${randomUUID()}`;

  const user = await getUser(userId);
  const usdAmount = await toUSD(amount, currency);
  const usdtAmount = usdToUsdt(usdAmount);

  // Record the deposit
  const deposit = await prisma.bankDeposit.create({
    data: {
      trackingId,
      userId,
      currency,
      amount,
      usdAmount,
      usdtAmount,
      bankName: rail,
      reference: railReference,
      status: 'PROCESSING',
    },
  });

  // User's Fireblocks USDT deposit address — B2BinPay sends directly here
  // Each user vault has its own on-chain address. No treasury hop needed.
  const userUsdtAddress = (user as typeof user & { usdtAddress?: string }).usdtAddress;
  if (!userUsdtAddress) {
    throw new Error(`User ${userId} has no Fireblocks USDT address configured. Run vault setup first.`);
  }

  await audit('BankDeposit', deposit.id, 'FIAT_ARRIVED', {
    rail, railReference, usdAmount,
    destination: `Fireblocks vault ${user.vaultId} (${userUsdtAddress})`,
  });

  try {
    // ── Step A: B2BinPay on-ramp ──────────────────────────────────────────
    // Tell B2BinPay: convert {amount} {currency} fiat → USDT
    // and send USDT directly to user's Fireblocks vault address.
    // B2BinPay → Fireblocks in ONE call. No treasury vault in between.
    const b2bDeposit = await createDeposit({
      walletId: user.b2bWalletId ?? B2B_WALLET_ID, // user's own B2BinPay wallet
      trackingId: `b2b_${trackingId}`,
      callbackUrl: `${CALLBACK}?depositId=${deposit.id}&userId=${userId}`,
      label: `FinCruse ${currency} deposit via ${rail} → vault ${user.vaultId}`,
    });

    await audit('BankDeposit', deposit.id, 'B2BINPAY_CONVERTING', {
      onrampId: b2bDeposit.id,
      from: `${amount} ${currency}`,
      to: `${usdtAmount} USDT`,
      destination: userUsdtAddress,
      note: 'B2BinPay will send USDT directly to Fireblocks vault — no treasury hop',
    });

    // ── Step B: B2BinPay sends USDT directly to Fireblocks ──────────────
    // This happens automatically when B2BinPay confirms conversion.
    // B2BinPay fires webhook → /webhooks/b2binpay
    // Fireblocks fires webhook → /webhooks/fireblocks (confirms vault received)
    // We also trigger a payout from B2BinPay wallet → Fireblocks address right now
    const payout = await createPayout({
      walletId: user.b2bWalletId ?? B2B_WALLET_ID,
      currencyId: 'USDT_SOL',
      address: userUsdtAddress,              // ← user's Fireblocks vault address
      amount: usdtAmount.toString(),
      feeAmount: '0',                        // Solana is near-gasless
      trackingId: `b2b_payout_${trackingId}`,
      callbackUrl: `${CALLBACK}?depositId=${deposit.id}&userId=${userId}&step=fireblocks_credit`,
      idempotencyKey: randomUUID(),
      label: `B2BinPay → Fireblocks vault_${user.vaultId}`,
    });

    await audit('BankDeposit', deposit.id, 'B2BINPAY_SENT_TO_FIREBLOCKS', {
      payoutId: payout.id,
      usdtAmount,
      fireblocksAddress: userUsdtAddress,
      vaultId: user.vaultId,
    });

    // Ledger credit happens in /webhooks/fireblocks once Fireblocks confirms USDT received
    const done = await prisma.bankDeposit.update({
      where: { id: deposit.id },
      data: {
        status: 'PENDING_FIREBLOCKS',
        onrampId: b2bDeposit.id,
        fbTxId: payout.id,
      },
    });

    await audit('BankDeposit', deposit.id, 'PENDING_FIREBLOCKS', { usdtAmount, vaultId: user.vaultId });
    return done;

  } catch (err) {
    await prisma.bankDeposit.update({ where: { id: deposit.id }, data: { status: 'FAILED' } });
    await audit('BankDeposit', deposit.id, 'FAILED', { error: String(err) });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 of every withdrawal: User requests to withdraw to bank/M-Pesa
// ─────────────────────────────────────────────────────────────────────────────

export async function handleWithdrawalRequest(params: {
  userId: string;
  currency: string;
  amount: number;
  rail: string;           // "mpesa" | "bank_transfer" | "rtgs"
  railDestination: string; // phone number, bank account, IBAN
  bankName: string;
}) {
  const { userId, currency, amount, rail, railDestination, bankName } = params;
  const trackingId = `wdr_${randomUUID()}`;

  const user = await getUser(userId);

  // Balance check first
  await checkSufficientBalance(userId, currency, amount);

  const usdAmount = await toUSD(amount, currency);
  const usdtAmount = usdToUsdt(usdAmount);

  const withdrawal = await prisma.withdrawal.create({
    data: {
      trackingId,
      userId,
      currency,
      amount,
      usdAmount,
      usdtAmount,
      bankAccount: railDestination,
      bankName: `${rail}:${bankName}`,
      status: 'PROCESSING',
    },
  });

  await audit('Withdrawal', withdrawal.id, 'REQUESTED', { rail, usdAmount });

  try {
    // ── Step A: Debit user ledger (atomic) ────────────────────────────
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await debit(tx, userId, currency, amount);
    });

    await audit('Withdrawal', withdrawal.id, 'LEDGER_DEBITED', { amount, currency });

    // ── Step B: Fireblocks vault debit ────────────────────────────────
    // Move USDT from user vault → FinCruse treasury vault
    const fbTx = await fbTransfer({
      assetId: USDT_ASSET,
      amount: usdtAmount.toString(),
      sourceVaultId: user.vaultId,
      destVaultId: TREASURY_VAULT,
      note: `FinCruse withdrawal ${trackingId} via ${rail}`,
      externalTxId: trackingId,
    });

    await audit('Withdrawal', withdrawal.id, 'FIREBLOCKS_DEBITED', { fbTxId: fbTx?.id });

    // ── Step C: B2BinPay off-ramp ─────────────────────────────────────
    // USDT → local fiat. B2BinPay pays out to our payout partner
    const estimate = await calculatePayoutFee({
      walletId: B2B_WALLET_ID,
      address: railDestination,
      amount: amount.toString(),
      currencyId: currency,
    });

    const payout = await createPayout({
      walletId: B2B_WALLET_ID,
      currencyId: currency,
      address: railDestination,
      amount: amount.toString(),
      feeAmount: estimate.fee.medium,
      trackingId: `b2b_wdr_${trackingId}`,
      callbackUrl: CALLBACK,
      idempotencyKey: randomUUID(),
      label: `FinCruse withdrawal ${trackingId}`,
    });

    await audit('Withdrawal', withdrawal.id, 'B2BINPAY_OFFRAMP_CREATED', { offrampId: payout.id });

    // ── Step D: Payout rail instruction ──────────────────────────────
    // B2BinPay instructs our payout partner to send fiat to railDestination
    // (M-Pesa STK push, bank RTGS, etc.)
    // The payout partner sends confirmation webhook → we update status there

    const done = await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'PENDING_PAYOUT', // waiting for payout rail confirmation
        fbTxId: fbTx?.id as string | undefined,
        offrampId: payout.id,
      },
    });

    await audit('Withdrawal', withdrawal.id, 'PENDING_PAYOUT_RAIL', { rail, railDestination });
    return done;

  } catch (err) {
    await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'FAILED' } });
    await audit('Withdrawal', withdrawal.id, 'FAILED', { error: String(err) });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P2P Transfer (user → user inside FinCruse)
// Supports same-currency (0 B2BinPay) and cross-currency (2 B2BinPay)
// ─────────────────────────────────────────────────────────────────────────────

export async function handleP2PTransfer(params: {
  senderId: string;
  receiverId: string;
  fromCurrency: string;
  toCurrency: string;
  amount: number;
  quoteId?: string;
  note?: string;
}) {
  const { senderId, receiverId, fromCurrency, toCurrency, amount, quoteId, note } = params;
  const trackingId = `p2p_${randomUUID()}`;
  const sameCurrency = fromCurrency.toUpperCase() === toCurrency.toUpperCase();

  const [sender, receiver] = await Promise.all([getUser(senderId), getUser(receiverId)]);
  await checkSufficientBalance(senderId, fromCurrency, amount);

  // Resolve quote (JIT locked or spot)
  const quote = quoteId
    ? consumeQuote(quoteId)
    : await createQuote({ fromCurrency, toCurrency, fromAmount: amount });

  const { toAmount, usdAmount, usdtAmount, rate: fxRate } = quote;

  const transfer = await prisma.transfer.create({
    data: {
      trackingId, senderId, receiverId, fromCurrency, toCurrency,
      fromAmount: amount, toAmount, usdAmount, usdtAmount, fxRate,
      note, status: 'PROCESSING',
    },
  });

  await audit('Transfer', transfer.id, 'CREATED', { sameCurrency, usdAmount });

  try {
    // ── Step A: Debit sender ledger ───────────────────────────────────
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await debit(tx, senderId, fromCurrency, amount);
    });

    let onrampId: string | undefined;
    let offrampId: string | undefined;
    let fbTxId: string | undefined;

    if (sameCurrency) {
      // ── SAME CURRENCY: 0 B2BinPay, 1 Fireblocks ────────────────────
      const fbTx = await fbTransfer({
        assetId: USDT_ASSET,
        amount: usdtAmount.toString(),
        sourceVaultId: sender.vaultId,
        destVaultId: receiver.vaultId,
        note: note ?? `FinCruse P2P ${trackingId}`,
        externalTxId: trackingId,
      });
      fbTxId = fbTx?.id as string | undefined;

    } else {
      // ── CROSS-CURRENCY: B2BinPay on-ramp + Fireblocks + B2BinPay off-ramp
      // On-ramp: sender fiat → USDT
      const dep = await createDeposit({
        walletId: B2B_WALLET_ID,
        trackingId: `onramp_${trackingId}`,
        callbackUrl: CALLBACK,
        label: `FinCruse P2P onramp ${trackingId}`,
      });
      onrampId = dep.id;

      // Fireblocks: sender vault → receiver vault
      const fbTx = await fbTransfer({
        assetId: USDT_ASSET,
        amount: usdtAmount.toString(),
        sourceVaultId: sender.vaultId,
        destVaultId: receiver.vaultId,
        externalTxId: trackingId,
      });
      fbTxId = fbTx?.id as string | undefined;

      // Off-ramp: USDT → receiver local fiat
      const est = await calculatePayoutFee({
        walletId: B2B_WALLET_ID,
        address: receiver.vaultId,
        amount: toAmount.toString(),
        currencyId: toCurrency,
      });
      const pay = await createPayout({
        walletId: B2B_WALLET_ID,
        currencyId: toCurrency,
        address: receiver.vaultId,
        amount: toAmount.toString(),
        feeAmount: est.fee.medium,
        trackingId: `offramp_${trackingId}`,
        callbackUrl: CALLBACK,
        idempotencyKey: randomUUID(),
      });
      offrampId = pay.id;
    }

    // ── Step B: Credit receiver ledger ────────────────────────────────
    await prisma.$transaction(async (tx: Parameters<typeof credit>[0]) => {
      await credit(tx, receiverId, toCurrency, toAmount);
    });

    const done = await prisma.transfer.update({
      where: { id: transfer.id },
      data: { status: 'COMPLETED', onrampId, offrampId, fbTxId },
    });

    await audit('Transfer', transfer.id, 'COMPLETED', { toAmount, toCurrency });
    return done;

  } catch (err) {
    await prisma.transfer.update({ where: { id: transfer.id }, data: { status: 'FAILED' } });
    await audit('Transfer', transfer.id, 'FAILED', { error: String(err) });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout rail webhook — confirms fiat reached the user's bank/M-Pesa
// Called by M-Pesa, bank partner, RTGS when payout settles
// ─────────────────────────────────────────────────────────────────────────────

export async function handlePayoutRailConfirmed(event: {
  trackingId: string;
  railReference: string;
  status: 'SUCCESS' | 'FAILED';
  amount?: number;
  currency?: string;
}) {
  const { trackingId, railReference, status } = event;

  const withdrawal = await prisma.withdrawal.findFirst({
    where: { trackingId: { contains: trackingId } },
  });

  if (!withdrawal) {
    console.warn(`[Orchestrator] No withdrawal found for trackingId ${trackingId}`);
    return;
  }

  const finalStatus = status === 'SUCCESS' ? 'COMPLETED' : 'PAYOUT_FAILED';
  await prisma.withdrawal.update({
    where: { id: withdrawal.id },
    data: { status: finalStatus },
  });

  await audit('Withdrawal', withdrawal.id, finalStatus, { railReference });

  if (status === 'FAILED') {
    // Reverse: credit user back if payout rail failed
    await prisma.$transaction(async (tx: Parameters<typeof credit>[0]) => {
      await credit(tx, withdrawal.userId, withdrawal.currency, Number(withdrawal.amount));
    });
    await audit('Withdrawal', withdrawal.id, 'REVERSED', { reason: 'payout rail failed' });
  }
}
