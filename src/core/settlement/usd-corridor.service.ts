/**
 * USD corridor — v1.
 *
 * The first corridor to run on the settlement engine, deliberately narrow:
 * USD in, USD out, USDT on Solana as the internal transport.
 *
 *   ADD FUNDS
 *     fiat USD confirmed at the rail
 *       → B2BinPay converts USD → USDT                      [leg 0]
 *       → B2BinPay sends USDT to the user's Fireblocks vault [leg 1]
 *       → Solana signature verified at `finalized`           [leg 2]
 *       → customer balance becomes spendable                 [leg 3]
 *
 *   WITHDRAWAL
 *     customer balance debited                               [leg 0]
 *       → USDT user vault → treasury                         [leg 1]
 *       → Solana signature verified at `finalized`           [leg 2]
 *       → B2BinPay converts USDT → USD                       [leg 3]
 *       → USD wired to the payout partner                    [leg 4]
 *
 * ── Two things this corrects from the previous implementation ──
 *
 * 1. Sequencing. `handleFiatArrived` asked B2BinPay to convert and then, in
 *    the same function, immediately requested a USDT payout to the user's
 *    vault — paying out USDT that did not exist yet. Leg 1 here does not start
 *    until leg 0 is confirmed.
 *
 * 2. Finality. A transfer used to be COMPLETED when the Fireblocks SDK
 *    returned an id. Leg 2 exists so that no customer balance moves on the
 *    strength of a custodian's acknowledgement alone.
 *
 * ── On "real-time" ──
 *
 * The Solana leg is genuinely real-time and provable: seconds, sub-cent,
 * with a signature anyone can check. The final USD wire to the payout partner
 * is a bank transfer and settles on banking rails — so it completes as
 * AWAITING_CONFIRMATION, not COMPLETED, and the partner's confirmation closes
 * it. Where a partner holds pre-funded float (`capability.prefundedFloat`) the
 * beneficiary is paid from that float first and this wire is replenishment;
 * that is the only configuration in which the *recipient's* experience is
 * real-time, and it costs working capital. `FundingPlan.payoutPrecedesFunding`
 * carries which of the two is in force.
 */

import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma, audit } from '../ledger.service';
import { AccountCode } from './accounts';
import { post } from './journal.service';
import { planLegs, executeLeg, confirmLeg, legsFor, nextLeg, compensateLeg, isTerminal } from './leg.service';
import { proveSettlement } from './proof.service';
import { withIdempotency } from '../idempotency.service';
import { usdToUsdt } from '../fx.service';
import { ports } from '../ports';

const USDT_ASSET = process.env.FIREBLOCKS_USDT_ASSET ?? 'USDT_SOL';
const TREASURY_VAULT = process.env.FIREBLOCKS_TREASURY_VAULT ?? '';
const B2B_WALLET_ID = process.env.B2BINPAY_WALLET_ID ?? '';
const CONVERTER = 'b2binpay';
const CALLBACK = () => `${process.env.API_BASE_URL}/webhooks/b2binpay`;

const dec = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

// ══════════════════════════════════════════════════════════════════════════════
//  ADD FUNDS
// ══════════════════════════════════════════════════════════════════════════════

export interface AddFundsParams {
  userId: string;
  /** USD amount confirmed as received. v1 is USD-only. */
  amount: number;
  rail: string;
  railReference: string;
  /** Caller-supplied idempotency key. Defaults to the rail reference, which is
   *  the natural one: the same bank credit must never be booked twice. */
  idempotencyKey?: string;
}

export async function addFunds(params: AddFundsParams) {
  const { userId, amount, rail, railReference } = params;

  assertUsd(amount);

  return withIdempotency(
    {
      scope: 'deposit',
      key: params.idempotencyKey ?? `${rail}:${railReference}`,
      request: { userId, amount, rail, railReference },
    },
    async ({ claim }) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const usdtAmount = usdToUsdt(amount);

      const vaultAddress = (user as { usdtAddress?: string }).usdtAddress;
      if (!vaultAddress) {
        throw Object.assign(
          new Error(`User ${userId} has no Fireblocks USDT address — run vault setup before accepting deposits`),
          { code: 'VAULT_NOT_PROVISIONED', statusCode: 409 },
        );
      }

      const trackingId = `dep_${randomUUID()}`;

      // The domain record, the opening journal entry and the leg plan are
      // written together. A crash after this point leaves a recoverable
      // settlement; a crash before it leaves nothing at all. There is no
      // window in which money is acknowledged but unplanned.
      const deposit = await prisma.$transaction(async tx => {
        const row = await tx.bankDeposit.create({
          data: {
            trackingId,
            userId,
            currency: 'USD',
            amount,
            usdAmount: amount,
            usdtAmount,
            bankName: rail,
            reference: railReference,
            status: 'PROCESSING',
          },
        });

        // Fiat is at the converter; we now owe the customer. The customer's
        // claim exists from this moment — it is simply not spendable until the
        // USDT is proven on chain, which the leg plan enforces.
        await post(tx, {
          eventType: 'DEPOSIT',
          entityType: 'BankDeposit',
          entityId: row.id,
          narrative: `USD ${amount} received via ${rail} (${railReference})`,
          postingKey: `BankDeposit:${row.id}:fiat-received`,
          lines: [
            { account: AccountCode.converter(CONVERTER, 'USD'), amount: dec(amount), currency: 'USD' },
            { account: AccountCode.user(userId, 'USD'), amount: dec(-amount), currency: 'USD', userId },
          ],
        });

        await planLegs(tx, 'BankDeposit', row.id, [
          { kind: 'CONVERT_FIAT_TO_CRYPTO', asset: 'USDT', amount: usdtAmount },
          { kind: 'CUSTODY_TRANSFER', asset: 'USDT', amount: usdtAmount, payload: { vaultAddress, vaultId: user.vaultId } },
          { kind: 'ONCHAIN_SETTLE', asset: 'USDT', amount: usdtAmount, payload: { vaultAddress } },
          { kind: 'LEDGER_CREDIT', asset: 'USD', amount },
        ]);

        return row;
      });

      await claim('BankDeposit', deposit.id);
      await audit('BankDeposit', deposit.id, 'PLANNED', { rail, railReference, amount, usdtAmount });

      // Drive as far as the external systems allow right now. Anything left
      // pending is picked up by the resume worker — this call returning is not
      // what makes the deposit succeed.
      await advanceDeposit(deposit.id).catch(err => {
        console.warn(`[usd] deposit ${deposit.id} paused: ${(err as Error).message}`);
      });

      return { trackingId, depositId: deposit.id, status: 'PROCESSING', amount, usdtAmount };
    },
  );
}

/**
 * Advance a deposit by one leg. Safe to call repeatedly and concurrently —
 * each leg is idempotent on its `externalKey`.
 */
export async function advanceDeposit(depositId: string): Promise<void> {
  const leg = await nextLeg('BankDeposit', depositId);
  if (!leg) return;

  const deposit = await prisma.bankDeposit.findUniqueOrThrow({ where: { id: depositId } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: deposit.userId } });
  const payload = (leg.payload ?? {}) as { vaultAddress?: string; vaultId?: string };

  switch (leg.kind) {
    // ── 0: fiat → USDT at the converter ──────────────────────────────────────
    // AWAITING_CONFIRMATION, not COMPLETED: the conversion is asynchronous and
    // the USDT does not exist until B2BinPay says so. This is the step the old
    // implementation skipped.
    case 'CONVERT_FIAT_TO_CRYPTO':
      await executeLeg(leg.id, async ({ externalKey }) => {
        const conversion = await ports().converter.createDeposit({
          walletId: user.b2bWalletId ?? B2B_WALLET_ID,
          trackingId: externalKey,
          callbackUrl: `${CALLBACK()}?depositId=${depositId}&leg=convert`,
          label: `Appra USD ${deposit.amount} → USDT for vault ${user.vaultId}`,
        });
        return { status: 'AWAITING_CONFIRMATION', externalRef: conversion.id };
      });
      break;

    // ── 1: converter → user's vault, on Solana ───────────────────────────────
    case 'CUSTODY_TRANSFER':
      await executeLeg(leg.id, async ({ externalKey, amount }) => {
        const payout = await ports().converter.createPayout({
          walletId: user.b2bWalletId ?? B2B_WALLET_ID,
          currencyId: 'USDT_SOL',
          address: payload.vaultAddress!,
          amount: (amount ?? dec(0)).toString(),
          feeAmount: '0',
          trackingId: externalKey,
          callbackUrl: `${CALLBACK()}?depositId=${depositId}&leg=custody`,
          idempotencyKey: externalKey,
          label: `USDT → Fireblocks vault ${user.vaultId}`,
        });
        return { status: 'AWAITING_CONFIRMATION', externalRef: payout.id };
      });
      break;

    // ── 2: prove it on chain ─────────────────────────────────────────────────
    case 'ONCHAIN_SETTLE': {
      const custodyLeg = (await legsFor('BankDeposit', depositId)).find(l => l.kind === 'CUSTODY_TRANSFER');
      const signature = (custodyLeg?.payload as { signature?: string } | null)?.signature;

      await executeLeg(leg.id, async ({ amount }) => {
        const result = await proveSettlement({
          entityType: 'BankDeposit',
          entityId: depositId,
          signature,
          asset: 'USDT',
          expectedAmount: amount ?? dec(0),
          toAddress: payload.vaultAddress,
        });

        // Still broadcasting — remain awaiting, the worker will look again.
        if (result.status === 'PENDING_BROADCAST') {
          return { status: 'AWAITING_CONFIRMATION' };
        }
        return { status: 'COMPLETED', externalRef: result.signature ?? undefined };
      });
      break;
    }

    // ── 3: funds become spendable ────────────────────────────────────────────
    // Wrapped in executeLeg like every other leg. Without it this leg never
    // entered IN_FLIGHT, so confirmLeg's PENDING → COMPLETED was an illegal
    // transition and threw *after* the credit had committed. The leg stayed
    // PENDING and every later attempt credited again — the resume worker runs
    // every 15s, so a completed deposit paid the customer indefinitely.
    case 'LEDGER_CREDIT':
      await executeLeg(leg.id, async () => {
      await prisma.$transaction(async tx => {
        const usdt = dec(deposit.usdtAmount);
        const usd = dec(deposit.amount);

        // Conversion is booked through FX_PNL as the clearing account so both
        // currency legs balance independently. Whatever accumulates in FX_PNL
        // is the converter's spread — visible and reportable rather than
        // silently absorbed into the difference between two numbers.
        await post(tx, {
          eventType: 'FX',
          entityType: 'BankDeposit',
          entityId: depositId,
          narrative: `Converted USD ${usd} → USDT ${usdt} via ${CONVERTER}`,
          postingKey: `BankDeposit:${depositId}:conversion`,
          lines: [
            { account: AccountCode.converter(CONVERTER, 'USD'), amount: usd.negated(), currency: 'USD' },
            { account: AccountCode.fxPnl('USD'), amount: usd, currency: 'USD' },
            { account: AccountCode.custody(user.vaultId, 'USDT'), amount: usdt, currency: 'USDT' },
            { account: AccountCode.fxPnl('USDT'), amount: usdt.negated(), currency: 'USDT' },
          ],
        });

        // Projection: keep Account.balance in step with the journal, inside the
        // same transaction. Reconciliation asserts the two agree.
        await tx.account.upsert({
          where: { userId_currency: { userId: deposit.userId, currency: 'USD' } },
          update: { balance: { increment: usd }, balanceUsd: { increment: usd } },
          create: { userId: deposit.userId, currency: 'USD', balance: usd, balanceUsd: usd },
        });

        await tx.bankDeposit.update({ where: { id: depositId }, data: { status: 'COMPLETED' } });
      });

      await audit('BankDeposit', depositId, 'COMPLETED', { amount: deposit.amount });
      return { status: 'COMPLETED' };
      });
      break;
  }

  // Chain onward while legs keep completing.
  const following = await nextLeg('BankDeposit', depositId);
  if (following && following.id !== leg.id && following.status === 'PENDING') {
    await advanceDeposit(depositId);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  WITHDRAWAL
// ══════════════════════════════════════════════════════════════════════════════

export interface WithdrawParams {
  userId: string;
  amount: number;
  /** Payout partner id, as registered in the BaaS registry. */
  providerId: string;
  /** Partner's receiving bank account for the USD wire. */
  partnerAccount: string;
  recipientName: string;
  idempotencyKey: string;
}

export async function withdraw(params: WithdrawParams) {
  const { userId, amount, providerId, partnerAccount, recipientName } = params;

  assertUsd(amount);

  return withIdempotency(
    { scope: 'withdrawal', key: params.idempotencyKey, request: { userId, amount, providerId, partnerAccount } },
    async ({ claim }) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const usdtAmount = usdToUsdt(amount);
      const trackingId = `wdr_${randomUUID()}`;

      const withdrawal = await prisma.$transaction(async tx => {
        // Balance check and debit in one transaction. Checking outside the
        // transaction, as the previous implementation did, lets two concurrent
        // withdrawals both observe a sufficient balance and both proceed.
        const account = await tx.account.findUniqueOrThrow({
          where: { userId_currency: { userId, currency: 'USD' } },
        });
        if (account.balance.lessThan(amount)) {
          throw Object.assign(
            new Error(`Insufficient balance: ${account.balance} USD available, ${amount} USD requested`),
            { code: 'INSUFFICIENT_BALANCE', statusCode: 422 },
          );
        }

        const row = await tx.withdrawal.create({
          data: {
            trackingId,
            userId,
            currency: 'USD',
            amount,
            usdAmount: amount,
            usdtAmount,
            bankAccount: partnerAccount,
            bankName: `${providerId}:${recipientName}`,
            status: 'PROCESSING',
          },
        });

        // The customer's claim is extinguished and replaced by our obligation
        // to deliver. SUSPENSE is transient by design: reconciliation asserts
        // it is flat at close of day, so a withdrawal that silently stalls
        // shows up as a suspense balance rather than disappearing.
        await post(tx, {
          eventType: 'WITHDRAWAL',
          entityType: 'Withdrawal',
          entityId: row.id,
          narrative: `Withdrawal of USD ${amount} to ${recipientName} via ${providerId}`,
          postingKey: `Withdrawal:${row.id}:debit`,
          lines: [
            { account: AccountCode.user(userId, 'USD'), amount: dec(amount), currency: 'USD', userId },
            { account: AccountCode.suspense('USD'), amount: dec(-amount), currency: 'USD' },
          ],
        });

        await tx.account.update({
          where: { userId_currency: { userId, currency: 'USD' } },
          data: { balance: { decrement: dec(amount) }, balanceUsd: { decrement: dec(amount) } },
        });

        await planLegs(tx, 'Withdrawal', row.id, [
          { kind: 'CUSTODY_TRANSFER', asset: 'USDT', amount: usdtAmount, payload: { from: user.vaultId, to: TREASURY_VAULT } },
          { kind: 'ONCHAIN_SETTLE', asset: 'USDT', amount: usdtAmount },
          { kind: 'CONVERT_CRYPTO_TO_FIAT', asset: 'USD', amount },
          { kind: 'PARTNER_PAYOUT', asset: 'USD', amount, payload: { providerId, partnerAccount, recipientName } },
        ]);

        return row;
      });

      await claim('Withdrawal', withdrawal.id);
      await audit('Withdrawal', withdrawal.id, 'PLANNED', { amount, providerId, usdtAmount });

      await advanceWithdrawal(withdrawal.id).catch(err => {
        console.warn(`[usd] withdrawal ${withdrawal.id} paused: ${(err as Error).message}`);
      });

      return { trackingId, withdrawalId: withdrawal.id, status: 'PROCESSING', amount };
    },
  );
}

export async function advanceWithdrawal(withdrawalId: string): Promise<void> {
  const leg = await nextLeg('Withdrawal', withdrawalId);
  if (!leg) return;

  // A leg that has spent its retry budget is not going to succeed on the next
  // pass. Leaving it there keeps the customer's money in suspense indefinitely
  // and keeps the worker retrying a payment that has already failed, so undo
  // the withdrawal instead of stalling on it.
  if (leg.status === 'FAILED' && leg.attempts >= leg.maxAttempts) {
    await compensateWithdrawal(
      withdrawalId,
      `${leg.kind} failed after ${leg.attempts} attempts: ${leg.lastError ?? 'no error recorded'}`,
    );
    return;
  }

  const withdrawal = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: withdrawal.userId } });
  const payload = (leg.payload ?? {}) as { providerId?: string; partnerAccount?: string; recipientName?: string };

  switch (leg.kind) {
    // ── 0: collect the USDT into treasury ────────────────────────────────────
    case 'CUSTODY_TRANSFER':
      await executeLeg(leg.id, async ({ externalKey, amount }) => {
        const tx = await ports().custody.createTransfer({
          assetId: USDT_ASSET,
          amount: (amount ?? dec(0)).toString(),
          sourceVaultId: user.vaultId,
          destVaultId: TREASURY_VAULT,
          note: `Appra withdrawal ${withdrawal.trackingId}`,
          externalTxId: externalKey,
        });

        await prisma.$transaction(async t =>
          post(t, {
            eventType: 'SETTLEMENT',
            entityType: 'Withdrawal',
            entityId: withdrawalId,
            narrative: `USDT ${amount} collected from user vault into treasury`,
            postingKey: `Withdrawal:${withdrawalId}:custody`,
            lines: [
              { account: AccountCode.custody(TREASURY_VAULT, 'USDT'), amount: amount ?? dec(0), currency: 'USDT' },
              { account: AccountCode.custody(user.vaultId, 'USDT'), amount: (amount ?? dec(0)).negated(), currency: 'USDT' },
            ],
          }),
        );

        return { status: 'AWAITING_CONFIRMATION', externalRef: (tx as { id?: string }).id };
      });
      break;

    // ── 1: prove the on-chain move ───────────────────────────────────────────
    case 'ONCHAIN_SETTLE': {
      const custody = (await legsFor('Withdrawal', withdrawalId)).find(l => l.kind === 'CUSTODY_TRANSFER');

      await executeLeg(leg.id, async ({ amount }) => {
        const result = await proveSettlement({
          entityType: 'Withdrawal',
          entityId: withdrawalId,
          custodyTxId: custody?.externalRef ?? undefined,
          asset: 'USDT',
          expectedAmount: amount ?? dec(0),
        });
        if (result.status === 'PENDING_BROADCAST') return { status: 'AWAITING_CONFIRMATION' };
        return { status: 'COMPLETED', externalRef: result.signature ?? undefined };
      });
      break;
    }

    // ── 2: USDT → USD at the converter ───────────────────────────────────────
    case 'CONVERT_CRYPTO_TO_FIAT':
      await executeLeg(leg.id, async ({ externalKey }) => {
        const usdt = dec(withdrawal.usdtAmount);
        const usd = dec(withdrawal.amount);

        await prisma.$transaction(async t =>
          post(t, {
            eventType: 'FX',
            entityType: 'Withdrawal',
            entityId: withdrawalId,
            narrative: `Converted USDT ${usdt} → USD ${usd} via ${CONVERTER}`,
            postingKey: `Withdrawal:${withdrawalId}:conversion`,
            lines: [
              { account: AccountCode.custody(TREASURY_VAULT, 'USDT'), amount: usdt.negated(), currency: 'USDT' },
              { account: AccountCode.fxPnl('USDT'), amount: usdt, currency: 'USDT' },
              { account: AccountCode.converter(CONVERTER, 'USD'), amount: usd, currency: 'USD' },
              { account: AccountCode.fxPnl('USD'), amount: usd.negated(), currency: 'USD' },
            ],
          }),
        );

        return { status: 'COMPLETED', externalRef: externalKey };
      });
      break;

    // ── 3: wire USD to the partner ───────────────────────────────────────────
    //
    // AWAITING_CONFIRMATION deliberately. B2BinPay debits our wallet at once,
    // but the money reaches the partner over banking rails. Marking this
    // COMPLETED on submission is how a system ends up reporting settled
    // payments that are still in a correspondent's queue.
    case 'PARTNER_PAYOUT':
      await executeLeg(leg.id, async ({ externalKey, amount }) => {
        const payout = await ports().converter.createPayout({
          walletId: B2B_WALLET_ID,
          currencyId: 'USD',
          address: payload.partnerAccount!,
          amount: (amount ?? dec(0)).toString(),
          feeAmount: '0',
          trackingId: externalKey,
          callbackUrl: `${CALLBACK()}?withdrawalId=${withdrawalId}&leg=payout`,
          idempotencyKey: externalKey,
          label: `Appra payout to ${payload.providerId} for ${payload.recipientName}`,
        });

        await prisma.withdrawal.update({
          where: { id: withdrawalId },
          data: { status: 'PENDING_PAYOUT', offrampId: payout.id },
        });

        return { status: 'AWAITING_CONFIRMATION', externalRef: payout.id };
      });
      break;
  }

  const following = await nextLeg('Withdrawal', withdrawalId);
  if (following && following.id !== leg.id && following.status === 'PENDING') {
    await advanceWithdrawal(withdrawalId);
  }
}

/**
 * Undo a withdrawal that cannot be delivered.
 *
 * A withdrawal debits the customer immediately and parks the money in
 * SUSPENSE, which is transient by design: reconciliation asserts it is flat at
 * close of day. So a settlement that fails after the debit and is never undone
 * leaves the customer short and the books holding a balance nobody owns. Until
 * now nothing emitted a COMPENSATE leg — the kind existed and was unreachable.
 *
 * What can be reversed depends on how far it got, and the boundary is real:
 *
 *   before CONVERT_CRYPTO_TO_FIAT — nothing has left the building. The debit
 *     is a journal entry and a projection, and both are ours to reverse.
 *
 *   after it — the USDT has been sold for USD at the converter. Putting the
 *     customer back means buying it again at whatever the rate is now, which
 *     is a treasury decision with a real cost, not a bookkeeping entry.
 *     Refuse, and say so, rather than invent a reversal that did not happen.
 */
export async function compensateWithdrawal(
  withdrawalId: string,
  reason: string,
): Promise<'COMPENSATED' | 'ALREADY_REVERSED' | 'NEEDS_TREASURY' | 'ALREADY_DELIVERED'> {
  const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  if (w.status === 'REVERSED') return 'ALREADY_REVERSED';
  // Money the beneficiary already has is not reversible by us. A refund is a
  // new payment in the other direction, with its own consent and its own legs.
  if (w.status === 'COMPLETED') return 'ALREADY_DELIVERED';

  const legs = await legsFor('Withdrawal', withdrawalId);
  const converted = legs.find(l => l.kind === 'CONVERT_CRYPTO_TO_FIAT')?.status === 'COMPLETED';

  if (converted) {
    await audit('Withdrawal', withdrawalId, 'COMPENSATION_NEEDS_TREASURY', {
      reason,
      amount: w.amount,
      note: 'USDT already sold for USD. Reversal requires a treasury buy-back, not a journal entry.',
    });
    console.error(
      `[usd] withdrawal ${w.trackingId} failed after conversion — ${w.amount} USD is at the converter ` +
      `and the customer is short. Needs treasury action.`,
    );
    return 'NEEDS_TREASURY';
  }

  await prisma.$transaction(async tx => {
    // The exact inverse of the debit posted in withdraw(). Same two accounts,
    // opposite signs, so the pair nets to zero and SUSPENSE returns to flat.
    await post(tx, {
      eventType: 'WITHDRAWAL',
      entityType: 'Withdrawal',
      entityId: withdrawalId,
      narrative: `Reversed — ${reason}`,
      postingKey: `Withdrawal:${withdrawalId}:compensation`,
      lines: [
        { account: AccountCode.user(w.userId, 'USD'), amount: dec(w.amount).negated(), currency: 'USD', userId: w.userId },
        { account: AccountCode.suspense('USD'), amount: dec(w.amount), currency: 'USD' },
      ],
    });

    await tx.account.update({
      where: { userId_currency: { userId: w.userId, currency: 'USD' } },
      data: { balance: { increment: dec(w.amount) }, balanceUsd: { increment: dec(w.amount) } },
    });

    await tx.withdrawal.update({ where: { id: withdrawalId }, data: { status: 'REVERSED' } });
  });

  // Close the open legs so the worker stops retrying something we have undone.
  for (const leg of legs) {
    if (!isTerminal(leg.status)) await compensateLeg(leg.id, reason);
  }

  await audit('Withdrawal', withdrawalId, 'COMPENSATED', { reason, amount: w.amount });
  return 'COMPENSATED';
}

/**
 * The partner confirmed the wire landed. Clears suspense and closes the
 * withdrawal — this is the only place a withdrawal becomes COMPLETED.
 */
export async function confirmPartnerPayout(withdrawalId: string, partnerReference: string): Promise<void> {
  const legs = await legsFor('Withdrawal', withdrawalId);
  const payoutLeg = legs.find(l => l.kind === 'PARTNER_PAYOUT');
  if (!payoutLeg || payoutLeg.status === 'COMPLETED') return;

  const withdrawal = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });

  await prisma.$transaction(async tx => {
    await post(tx, {
      eventType: 'WITHDRAWAL',
      entityType: 'Withdrawal',
      entityId: withdrawalId,
      narrative: `Partner confirmed receipt of USD ${withdrawal.amount} (ref ${partnerReference})`,
      postingKey: `Withdrawal:${withdrawalId}:delivered`,
      lines: [
        { account: AccountCode.suspense('USD'), amount: dec(withdrawal.amount), currency: 'USD' },
        { account: AccountCode.converter(CONVERTER, 'USD'), amount: dec(withdrawal.amount).negated(), currency: 'USD' },
      ],
    });

    await tx.withdrawal.update({ where: { id: withdrawalId }, data: { status: 'COMPLETED' } });
  });

  await confirmLeg(payoutLeg.id, partnerReference);
  await audit('Withdrawal', withdrawalId, 'COMPLETED', { partnerReference });
}

// ── helpers ───────────────────────────────────────────────────────────────────

function assertUsd(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error(`Amount must be a positive number, got ${amount}`), {
      code: 'INVALID_AMOUNT',
      statusCode: 422,
    });
  }
}
