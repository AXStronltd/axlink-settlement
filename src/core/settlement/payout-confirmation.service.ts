/**
 * Closing a withdrawal from a partner webhook.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  THE PROBLEM THIS SOLVES
 *
 *  Three webhook routes — Brainrock, Daraja, Choice Bank — each closed a
 *  withdrawal by writing `status: 'COMPLETED'` straight onto the row. None of
 *  them touched the settlement engine. So the PARTNER_PAYOUT leg stayed
 *  AWAITING_CONFIRMATION forever, and the journal entry that clears suspense
 *  never posted.
 *
 *  The customer saw a completed withdrawal while the books still showed the
 *  money sitting in SUSPENSE:USD. Every real payout left a balance behind that
 *  reconciliation is built to treat as an incident.
 *
 *  `confirmPartnerPayout` already does this correctly and is the only place a
 *  withdrawal is supposed to become COMPLETED. It had exactly one caller: the
 *  manual ops endpoint. In other words, the automated path was wrong and the
 *  hand-driven one was right.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Why this is not just a call to `confirmPartnerPayout`:
 *
 * That function returns early when there is no PARTNER_PAYOUT leg, which is
 * the case for every withdrawal created before the settlement engine existed
 * (and for any corridor not yet migrated onto it). Calling it blindly would
 * mean those withdrawals were never marked COMPLETED at all — trading a
 * bookkeeping bug for a stuck-payment bug.
 *
 * So: use the settlement path when there is a leg, fall back to the direct
 * update when there is not, and say which one happened.
 */

import { prisma, audit, credit } from '../ledger.service';
import { legsFor } from './leg.service';
import { confirmPartnerPayout, compensateWithdrawal } from './usd-corridor.service';

export type ConfirmOutcome =
  /** Settlement engine closed it: leg confirmed, suspense cleared. */
  | 'SETTLED'
  /** No PARTNER_PAYOUT leg — pre-settlement-engine withdrawal, closed directly. */
  | 'LEGACY'
  /** Already COMPLETED. Webhooks are re-delivered; this is normal, not an error. */
  | 'ALREADY_CLOSED'
  /** No withdrawal with that id. */
  | 'NOT_FOUND';

/**
 * Close a withdrawal because a payout partner confirmed the money landed.
 *
 * Idempotent: partners re-deliver webhooks, and re-delivery must not post the
 * journal entry twice. `confirmPartnerPayout` guards on leg status, and the
 * legacy path guards on withdrawal status.
 *
 * @param providerId  Which partner confirmed — for the audit trail and logs.
 */
export async function confirmWithdrawalFromPartner(params: {
  withdrawalId: string;
  partnerReference: string;
  providerId: string;
}): Promise<ConfirmOutcome> {
  const { withdrawalId, partnerReference, providerId } = params;

  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
    select: { id: true, trackingId: true, status: true },
  });

  if (!withdrawal) return 'NOT_FOUND';
  if (withdrawal.status === 'COMPLETED') return 'ALREADY_CLOSED';

  const legs = await legsFor('Withdrawal', withdrawalId);
  const hasPayoutLeg = legs.some(l => l.kind === 'PARTNER_PAYOUT');

  if (hasPayoutLeg) {
    // Confirms the leg, posts suspense → converter, marks COMPLETED, audits.
    await confirmPartnerPayout(withdrawalId, partnerReference);
    console.log(
      `[${providerId}] Withdrawal ${withdrawal.trackingId} closed via settlement engine ` +
      `— leg confirmed, suspense cleared (ref ${partnerReference})`,
    );
    return 'SETTLED';
  }

  // No leg: this withdrawal predates the settlement engine. Close it the old
  // way so it does not hang, and record that the books were not touched — a
  // withdrawal closed on this path leaves no journal entry behind it.
  await prisma.withdrawal.update({
    where: { id: withdrawalId },
    data: { status: 'COMPLETED' },
  });
  await audit('Withdrawal', withdrawalId, 'COMPLETED_WITHOUT_SETTLEMENT', {
    providerId,
    partnerReference,
    note: 'No PARTNER_PAYOUT leg — closed directly. No journal entry posted.',
  });
  console.warn(
    `[${providerId}] Withdrawal ${withdrawal.trackingId} closed on the legacy path ` +
    `— no settlement leg, so no journal entry (ref ${partnerReference})`,
  );
  return 'LEGACY';
}

export type ReverseOutcome =
  /** Settlement engine reversed it: journal entry posted, legs compensated. */
  | 'COMPENSATED'
  /** Pre-settlement-engine withdrawal — projection reversed, no journal entry. */
  | 'LEGACY'
  /** Already reversed. Webhooks are re-delivered; this is normal. */
  | 'ALREADY_REVERSED'
  /** Already delivered — a refund is a new payment, not a reversal. */
  | 'ALREADY_DELIVERED'
  /** USDT was already sold; putting the customer back needs treasury action. */
  | 'NEEDS_TREASURY'
  /** No withdrawal with that id. */
  | 'NOT_FOUND';

/**
 * Reverse a withdrawal because a payout partner reported it failed.
 *
 * The three webhook routes each did this by hand: credit the Account
 * projection, set REVERSED, done. No journal entry, no leg compensation. So a
 * reversed withdrawal left the journal still holding the money in SUSPENSE
 * while the projection showed it back with the customer — I-3 and I-4 both
 * broken, on every failed payout, silently.
 *
 * Why this is not just a call to compensateWithdrawal: a withdrawal created by
 * the legacy orchestrator never posted to the journal at all. Its debit was a
 * projection change only. Posting a compensating entry for one would credit a
 * suspense balance that was never debited — inventing a reversal of something
 * that never happened, which is a worse lie than the one being fixed.
 *
 * So: the engine reverses what the engine created, and legacy withdrawals are
 * reversed the way they were debited, with the difference recorded.
 */
export async function reverseWithdrawalFromPartner(params: {
  withdrawalId: string;
  reason: string;
  providerId: string;
}): Promise<ReverseOutcome> {
  const { withdrawalId, reason, providerId } = params;

  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
    select: { id: true, trackingId: true, status: true, userId: true, currency: true, amount: true },
  });

  if (!withdrawal) return 'NOT_FOUND';
  if (withdrawal.status === 'REVERSED') return 'ALREADY_REVERSED';
  if (withdrawal.status === 'COMPLETED') return 'ALREADY_DELIVERED';

  const legs = await legsFor('Withdrawal', withdrawalId);
  const onEngine = legs.length > 0 && withdrawal.currency === 'USD';

  if (onEngine) {
    const outcome = await compensateWithdrawal(withdrawalId, `${providerId}: ${reason}`);
    console.log(
      `[${providerId}] Withdrawal ${withdrawal.trackingId} reversed via settlement engine — ${outcome}`,
    );
    return outcome === 'NEEDS_TREASURY' ? 'NEEDS_TREASURY'
      : outcome === 'ALREADY_REVERSED' ? 'ALREADY_REVERSED'
      : outcome === 'ALREADY_DELIVERED' ? 'ALREADY_DELIVERED'
      : 'COMPENSATED';
  }

  // Legacy: the debit was a projection change, so the reversal is too.
  await prisma.$transaction(async tx => {
    await credit(tx as Parameters<typeof credit>[0], withdrawal.userId, withdrawal.currency, withdrawal.amount);
    await tx.withdrawal.update({ where: { id: withdrawalId }, data: { status: 'REVERSED' } });
  });
  await audit('Withdrawal', withdrawalId, 'REVERSED_WITHOUT_SETTLEMENT', {
    providerId,
    reason,
    amount: withdrawal.amount,
    currency: withdrawal.currency,
    note: 'No settlement legs — projection reversed directly. No journal entry posted.',
  });
  console.warn(
    `[${providerId}] Withdrawal ${withdrawal.trackingId} reversed on the legacy path ` +
    `— no journal entry (${reason})`,
  );
  return 'LEGACY';
}
