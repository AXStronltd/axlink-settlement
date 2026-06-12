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
import { toUSD, usdToUsdt } from './fx.service';
import { createDeposit, createPayout, calculatePayoutFee } from './b2binpay.service';
import { createTransfer as fbTransfer } from './fireblocks.service';
import { sendPayment, resolvePaymentType, type PaymentDestination } from './brainrock.service';
import { sendTransfer as choiceBankTransfer, isChoiceBankCurrency, type ChoiceBankDestination } from './choicebank.service';
import { sendB2C, isDarajaCurrency, normalizeMsisdn } from './daraja.service';
import { consumeQuote, createQuote } from './quote.service';

// ── Corridor routing ──────────────────────────────────────────────────────────
// TZS/UGX     → Daraja (M-Pesa B2C)
// NGN/GHS/ZAR/KES → Choice Bank (bank transfer — includes Kenya)
// GBP/USD/EUR/CAD → Brainrock (Faster Payments / SEPA / ACH — EU, UK, USA, Canada)

async function deliverFiat(params: {
  destination: PaymentDestination;
  amount: number;
  currency: string;
  reference: string;
  description: string;
}): Promise<{ provider: string; paymentId: string }> {
  const { destination, amount, currency, reference, description } = params;

  if (isDarajaCurrency(currency)) {
    // M-Pesa B2C — requires a mobile number
    const phone = destination.mobileNumber;
    if (!phone) throw new Error(`M-Pesa payout requires mobileNumber for ${currency}`);
    const result = await sendB2C({
      amount,
      phoneNumber: normalizeMsisdn(phone),
      reference,
      occasion: description,
    });
    return { provider: 'daraja', paymentId: result.ConversationID };
  }

  if (isChoiceBankCurrency(currency)) {
    // Choice Bank Nigeria — requires bank account details
    const cbDest: ChoiceBankDestination = {
      accountNumber: destination.bankAccountNumber ?? destination.accountNumber ?? '',
      bankCode:      destination.bankCode ?? '',
      accountName:   destination.name,
      currency:      currency as import('./choicebank.service').ChoiceBankCurrency,
    };
    if (!cbDest.accountNumber || !cbDest.bankCode) {
      throw new Error(`Choice Bank payout requires accountNumber + bankCode for ${currency}`);
    }
    const result = await choiceBankTransfer({ destination: cbDest, amount, reference, narration: description });
    return { provider: 'choicebank', paymentId: result.id };
  }

  // Brainrock — GBP, USD, EUR, CAD, AED
  const result = await sendPayment({
    fromAccountId: BRAINROCK_TREASURY,
    destination: { ...destination, type: destination.type ?? resolvePaymentType(currency, destination) },
    amount,
    currency,
    reference,
    description,
  });
  return { provider: 'brainrock', paymentId: result.id };
}

const USDT_ASSET = process.env.FIREBLOCKS_USDT_ASSET ?? 'USDT_SOL';
const B2B_WALLET_ID = process.env.B2BINPAY_WALLET_ID ?? '';
const TREASURY_VAULT = process.env.FIREBLOCKS_TREASURY_VAULT ?? '';
const BRAINROCK_TREASURY = process.env.BRAINROCK_TREASURY_ACCOUNT_ID ?? '';
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
  destination: PaymentDestination; // where fiat goes: bank, M-Pesa, IBAN
  recipientName: string;
}) {
  const { userId, currency, amount, destination, recipientName } = params;
  const trackingId = `wdr_${randomUUID()}`;

  const user = await getUser(userId);
  await checkSufficientBalance(userId, currency, amount);

  const usdAmount = await toUSD(amount, currency);
  const usdtAmount = usdToUsdt(usdAmount);

  destination.type = destination.type ?? resolvePaymentType(currency, destination);

  const withdrawal = await prisma.withdrawal.create({
    data: {
      trackingId,
      userId,
      currency,
      amount,
      usdAmount,
      usdtAmount,
      bankAccount: destination.mobileNumber ?? destination.iban ?? destination.accountNumber ?? '',
      bankName: `${destination.type}:${recipientName}`,
      status: 'PROCESSING',
    },
  });

  await audit('Withdrawal', withdrawal.id, 'REQUESTED', { destination: destination.type, usdAmount });

  try {
    // ── A: Debit user ledger ──────────────────────────────────────────
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await debit(tx, userId, currency, amount);
    });

    await audit('Withdrawal', withdrawal.id, 'LEDGER_DEBITED', { amount, currency });

    // ── B: Fireblocks — user vault → FinCruse treasury vault (USDT) ──
    const fbTx = await fbTransfer({
      assetId: USDT_ASSET,
      amount: usdtAmount.toString(),
      sourceVaultId: user.vaultId,
      destVaultId: TREASURY_VAULT,
      note: `FinCruse withdrawal ${trackingId}`,
      externalTxId: trackingId,
    });

    await audit('Withdrawal', withdrawal.id, 'FIREBLOCKS_DEBITED', { fbTxId: fbTx?.id });

    // ── C: B2BinPay off-ramp — USDT → fiat (credits FinCruse B2BinPay balance) ──
    const estimate = await calculatePayoutFee({
      walletId: B2B_WALLET_ID,
      address: destination.mobileNumber ?? destination.iban ?? destination.accountNumber ?? '',
      amount: amount.toString(),
      currencyId: currency,
    });

    const b2bPayout = await createPayout({
      walletId: B2B_WALLET_ID,
      currencyId: currency,
      address: BRAINROCK_TREASURY,
      amount: amount.toString(),
      feeAmount: estimate.fee.medium,
      trackingId: `b2b_wdr_${trackingId}`,
      callbackUrl: CALLBACK,
      idempotencyKey: randomUUID(),
      label: `FinCruse withdrawal ${trackingId} → Brainrock treasury`,
    });

    await audit('Withdrawal', withdrawal.id, 'B2BINPAY_OFFRAMP_CREATED', { offrampId: b2bPayout.id });

    // ── D: Route fiat delivery by currency corridor ──────────────────────
    // KES/TZS/UGX → Daraja M-Pesa B2C
    // NGN/GHS/ZAR  → Choice Bank Nigeria bank transfer
    // GBP/USD/EUR/CAD/AED → Brainrock Faster Payments / SEPA / ACH
    const payout = await deliverFiat({
      destination: { ...destination, name: recipientName },
      amount,
      currency,
      reference: trackingId,
      description: `FinCruse withdrawal ${trackingId}`,
    });

    await audit('Withdrawal', withdrawal.id, 'PAYOUT_SENT', {
      provider:   payout.provider,
      paymentId:  payout.paymentId,
      destination: destination.type ?? currency,
    });

    // Confirmation arrives via provider webhook:
    //   Daraja  → POST /webhooks/daraja/b2c/result
    //   Choice Bank → POST /webhooks/choicebank
    //   Brainrock   → POST /webhooks/brainrock
    const done = await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'PENDING_PAYOUT',
        fbTxId: fbTx?.id as string | undefined,
        offrampId: b2bPayout.id,
        brainrockPaymentId: payout.paymentId,
      },
    });

    await audit('Withdrawal', withdrawal.id, 'PENDING_PAYOUT', {
      provider:  payout.provider,
      paymentId: payout.paymentId,
    });
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
  receiverDestination?: PaymentDestination; // for cross-border: where receiver gets fiat
}) {
  const { senderId, receiverId, fromCurrency, toCurrency, amount, quoteId, note, receiverDestination } = params;
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

      // Off-ramp: USDT → local fiat (credits FinCruse B2BinPay balance)
      const est = await calculatePayoutFee({
        walletId: B2B_WALLET_ID,
        address: BRAINROCK_TREASURY,
        amount: toAmount.toString(),
        currencyId: toCurrency,
      });
      const pay = await createPayout({
        walletId: B2B_WALLET_ID,
        currencyId: toCurrency,
        address: BRAINROCK_TREASURY,
        amount: toAmount.toString(),
        feeAmount: est.fee.medium,
        trackingId: `offramp_${trackingId}`,
        callbackUrl: CALLBACK,
        idempotencyKey: randomUUID(),
      });
      offrampId = pay.id;

      // Route fiat delivery to receiver via correct corridor (if destination provided).
      // If no destination, receiver stays on FinCruse ledger and can withdraw later.
      if (receiverDestination) {
        await deliverFiat({
          destination: { ...receiverDestination, name: receiver.name },
          amount:      toAmount,
          currency:    toCurrency,
          reference:   `p2p_${trackingId}`,
          description: `FinCruse transfer from ${sender.name}`,
        });
      }
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
