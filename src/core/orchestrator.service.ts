/**
 * AxLink Orchestrator — Settlement Engine
 *
 * ══════════════════════════════════════════════════════════════════════
 *  INVARIANT: ALL USDT/SOLANA ACTIVITY IS INTERNAL TO AXLINK.
 *  External rails (Daraja, ChoiceBank, Brainrock, any bank) see ONLY
 *  fiat instructions. They never receive a crypto address, a USDT
 *  amount, or any reference to Solana. The conversion is AxLink's work.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Each user account is permanently paired:
 *   user.b2bWalletId  = their B2BinPay wallet (AxLink internal onramp tool)
 *   user.vaultId      = their Fireblocks vault (holds USDT — user never sees this)
 *   user.usdtAddress  = their Fireblocks USDT_SOL deposit address
 *
 * DEPOSIT flow (FIAT IN → user sees local currency credited):
 *   Local rail delivers fiat to AxLink's corridor account
 *   → AxLink internally: B2BinPay converts fiat → USDT → Fireblocks user vault
 *   → Fireblocks webhook confirms receipt → AxLink credits user ledger in fiat
 *   External rail sees: "user paid KES 1000 to AxLink till" (pure fiat)
 *
 * WITHDRAWAL flow (ZERO PRE-FUNDED — JIT liquidity):
 *   Debit user ledger
 *   → Fireblocks: user vault → AxLink treasury vault (USDT collected internally)
 *   → BaaS registry: JIT USDT→fiat conversion via B2BinPay + corridor delivery
 *     Two-phase: B2BinPay converts USDT→fiat → Daraja/ChoiceBank/Brainrock delivers
 *     Atomic (Thunes): conversion + delivery in one call
 *   External rail sees: "send 1000 KES to +254..." — no USDT, no pre-funding
 *   User can pick ANY method: mobile money, bank transfer, card — registry routes
 *
 * P2P TRANSFER (user → user, same or cross currency):
 *   Debit sender ledger
 *   → Fireblocks: sender vault → receiver vault (USDT moves inside AxLink, invisible to users)
 *   → Credit receiver ledger in their local currency
 *   → (optional) If external delivery: deliverFiat() pays recipient via local rail
 *   External rail sees: pure fiat instruction only
 */

import { randomUUID } from 'crypto';
import { prisma, debit, credit, checkSufficientBalance, getUser, audit } from './ledger.service';
import { toUSD, usdToUsdt } from './fx.service';
import { createDeposit, createPayout } from '../providers/live/b2binpay';
import { createTransfer as fbTransfer } from '../providers/live/fireblocks';
import { type PaymentDestination } from './baas.interface';
import { deliverFiat } from './baas-registry.service';
import { consumeQuote, createQuote } from './quote.service';
import { requestValidation, type PaymentType } from './kafka.service';

// Validate via event bus before any ledger write. Throws if rejected.
async function validateOrReject(type: PaymentType, payload: Parameters<typeof requestValidation>[0]['payload']): Promise<void> {
  const result = await requestValidation({ type, payload });
  if (!result.approved) {
    throw Object.assign(new Error(result.reason ?? 'Payment rejected by validator'), { code: 'PAYMENT_REJECTED', statusCode: 422 });
  }
}

const USDT_ASSET    = process.env.FIREBLOCKS_USDT_ASSET  ?? 'USDT_SOL';
const B2B_WALLET_ID = process.env.B2BINPAY_WALLET_ID     ?? '';
const TREASURY_VAULT = process.env.FIREBLOCKS_TREASURY_VAULT ?? '';
const CALLBACK      = `${process.env.API_BASE_URL}/webhooks/b2binpay`;

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
  existingDepositId?: string; // set when called from user-initiated Add Funds flow
}) {
  const { userId, currency, amount, rail, railReference, existingDepositId } = event;

  // ── Kafka validation gate — must pass before any DB write ────────────────
  await validateOrReject('DEPOSIT', { userId, currency, amount, rail });

  const user = await getUser(userId);
  const usdAmount = await toUSD(amount, currency);
  const usdtAmount = usdToUsdt(usdAmount);

  let deposit: Awaited<ReturnType<typeof prisma.bankDeposit.create>>;

  if (existingDepositId) {
    // Update the record created by initiateDeposit — keep its trackingId / sessionId
    deposit = await prisma.bankDeposit.update({
      where: { id: existingDepositId },
      data: { usdAmount, usdtAmount, bankName: rail, reference: railReference, status: 'PROCESSING' },
    });
  } else {
    // Push-style deposit (M-Pesa webhook, bank push) — create a fresh record
    const trackingId = `dep_${randomUUID()}`;
    deposit = await prisma.bankDeposit.create({
      data: {
        trackingId, userId, currency, amount, usdAmount, usdtAmount,
        bankName: rail, reference: railReference, status: 'PROCESSING',
      },
    });
  }

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
      trackingId: `b2b_${deposit.trackingId}`,
      callbackUrl: `${CALLBACK}?depositId=${deposit.id}&userId=${userId}`,
      label: `AxLink ${currency} deposit via ${rail} → vault ${user.vaultId}`,
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
      trackingId: `b2b_payout_${deposit.trackingId}`,
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

  // ── Kafka validation gate — must pass before any DB write ────────────────
  await validateOrReject('WITHDRAWAL', { userId, currency, amount, destination: destination as unknown as Record<string, unknown> });

  const trackingId = `wdr_${randomUUID()}`;

  const user = await getUser(userId);
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
      bankAccount: destination.mobileNumber ?? destination.iban ?? destination.accountNumber ?? '',
      bankName: `${destination.type}:${recipientName}`,
      status: 'PROCESSING',
    },
  });

  await audit('Withdrawal', withdrawal.id, 'REQUESTED', { destination: destination.type, usdAmount });

  // Whether we have taken the customer's money yet. Everything after the debit
  // can throw — a missing float account, a partner timeout, a rejected payout —
  // and the money must go back when it does.
  let debited = false;

  try {
    // ── A: Debit user ledger ──────────────────────────────────────────
    await prisma.$transaction(async (tx: Parameters<typeof debit>[0]) => {
      await debit(tx, userId, currency, amount);
    });
    debited = true;

    await audit('Withdrawal', withdrawal.id, 'LEDGER_DEBITED', { amount, currency });

    // ── B: Fireblocks — user vault → AxLink treasury vault (USDT collected internally) ──
    // The USDT never leaves AxLink. The payout partner in step C never sees crypto.
    const fbTx = await fbTransfer({
      assetId: USDT_ASSET,
      amount: usdtAmount.toString(),
      sourceVaultId: user.vaultId,
      destVaultId: TREASURY_VAULT,
      note: `AxLink withdrawal ${trackingId}`,
      externalTxId: trackingId,
    });

    await audit('Withdrawal', withdrawal.id, 'FIREBLOCKS_DEBITED', {
      fbTxId: fbTx?.id,
      note: 'USDT collected into AxLink treasury — payout will be from corridor fiat float',
    });

    // ── C: JIT fiat delivery — BaaS registry converts USDT + delivers fiat ─
    // Registry selects best provider for this currency + destination method.
    // Two-phase providers: B2BinPay converts USDT → fiat JIT, then delivers.
    // Atomic providers (Thunes): conversion + delivery in one call.
    // Payout partner sees ONLY: "send X KES/NGN/GBP to [destination]" — no USDT.
    const payout = await deliverFiat({
      destination: { ...destination, name: recipientName },
      amount,
      usdtAmount,
      currency,
      reference:   trackingId,
      description: `AxLink withdrawal ${trackingId}`,
    });

    await audit('Withdrawal', withdrawal.id, 'PAYOUT_SENT', {
      provider:    payout.provider,
      paymentId:   payout.paymentId,
      destination: destination.type ?? currency,
      note:        'Fiat only — USDT is internal, not visible to payout partner',
    });

    const done = await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'PENDING_PAYOUT',
        fbTxId: fbTx?.id as string | undefined,
        brainrockPaymentId: payout.paymentId,
      },
    });

    await audit('Withdrawal', withdrawal.id, 'PENDING_PAYOUT', {
      provider:  payout.provider,
      paymentId: payout.paymentId,
    });
    return done;

  } catch (err) {
    // Return the money if we took it. Reversal used to exist only on the
    // partner webhooks (payment.failed), so any failure raised before a partner
    // was ever contacted left the debit stranded: the withdrawal read FAILED
    // while the customer's balance stayed short. A missing env var did it.
    if (debited) {
      try {
        await prisma.$transaction(async (tx: Parameters<typeof credit>[0]) => {
          await credit(tx, userId, currency, amount);
        });
        await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'REVERSED' } });
        await audit('Withdrawal', withdrawal.id, 'REVERSED', {
          amount, currency, reason: 'payout failed before delivery', error: String(err),
        });
      } catch (reversalErr) {
        // The reversal itself failed. The customer is short and no automated
        // path will fix it, so say so as loudly as possible.
        await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'FAILED' } });
        await audit('Withdrawal', withdrawal.id, 'REVERSAL_FAILED', {
          amount, currency, originalError: String(err), reversalError: String(reversalErr),
        });
        console.error(
          `[Orchestrator] REVERSAL FAILED for withdrawal ${trackingId} — ` +
          `${amount} ${currency} debited from user ${userId} and NOT returned. Manual credit required.`,
          reversalErr,
        );
      }
    } else {
      await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'FAILED' } });
      await audit('Withdrawal', withdrawal.id, 'FAILED', { error: String(err) });
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P2P Transfer (user → user inside AxLink)
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

  // ── Kafka validation gate — must pass before any DB write ────────────────
  await validateOrReject('P2P_TRANSFER', { senderId, receiverId, fromCurrency, toCurrency, amount });

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

    let fbTxId: string | undefined;

    // ── Fireblocks vault-to-vault (USDT moves entirely inside AxLink) ─────
    // Same-currency: sender → receiver directly.
    // Cross-currency: sender → receiver; the FX is already priced in the quote.
    // AxLink Fireblocks LP won the RFQ: treasury → receiver vault.
    // In ALL cases the USDT transport is invisible — neither sender nor receiver
    // sees crypto. External payout partners (step below) see fiat only.
    if (quote.lpSource === 'axlink-fireblocks' && !sameCurrency) {
      const fbTx = await fbTransfer({
        assetId: USDT_ASSET,
        amount: usdtAmount.toString(),
        sourceVaultId: TREASURY_VAULT,
        destVaultId: receiver.vaultId,
        note: `AxLink internal settlement ${trackingId}`,
        externalTxId: trackingId,
      });
      fbTxId = fbTx?.id as string | undefined;
    } else {
      const fbTx = await fbTransfer({
        assetId: USDT_ASSET,
        amount: usdtAmount.toString(),
        sourceVaultId: sender.vaultId,
        destVaultId: receiver.vaultId,
        note: note ?? `AxLink P2P ${trackingId}`,
        externalTxId: trackingId,
      });
      fbTxId = fbTx?.id as string | undefined;
    }

    await audit('Transfer', transfer.id, 'FIREBLOCKS_SETTLED', {
      fbTxId,
      note: 'USDT moved inside AxLink — invisible to users and external partners',
    });

    // ── Step B: Credit receiver ledger (in their local currency) ────────
    await prisma.$transaction(async (tx: Parameters<typeof credit>[0]) => {
      await credit(tx, receiverId, toCurrency, toAmount);
    });

    // ── Step C (optional): JIT external fiat delivery ────────────────────
    // If receiver wants fiat pushed immediately, registry handles JIT
    // USDT→fiat conversion + delivery. Zero pre-funding required.
    if (receiverDestination) {
      const payout = await deliverFiat({
        destination: { ...receiverDestination, name: receiver.name },
        amount:      toAmount,
        usdtAmount,
        currency:    toCurrency,
        reference:   `p2p_${trackingId}`,
        description: `AxLink transfer from ${sender.name}`,
      });
      await audit('Transfer', transfer.id, 'EXTERNAL_PAYOUT_SENT', {
        provider: payout.provider, paymentId: payout.paymentId,
        note: 'Fiat delivery only — payout partner never sees USDT',
      });
    }

    const done = await prisma.transfer.update({
      where: { id: transfer.id },
      data: { status: 'COMPLETED', fbTxId },
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
