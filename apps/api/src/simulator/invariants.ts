/**
 * Invariant checks.
 *
 * This is what separates a harness from a demo. Running a deposit and seeing
 * status COMPLETED proves almost nothing — the interesting question is whether
 * the books are still true afterwards, and they are exactly as likely to be
 * wrong on the happy path as on a failure.
 *
 * These mirror the invariants in the architecture blueprint (I-1 … I-8), and
 * every scenario asserts all of them. A scenario that passes its own narrow
 * expectation while breaking a global invariant is a failed scenario.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../../../packages/core/ledger/ledger.service';
import { trialBalance } from '../../../../packages/core/ledger/journal.service';

export interface Check {
  id: string;
  name: string;
  passed: boolean;
  detail?: string;
}

const ZERO = new Prisma.Decimal(0);
const EPSILON = new Prisma.Decimal('0.0000000001');

/** Scope every query to entities this run created, so a shared database is safe. */
export interface Scope {
  userIds: string[];
  depositIds: string[];
  withdrawalIds: string[];
}

export async function checkAll(scope: Scope): Promise<Check[]> {
  return [
    await trialBalanceBalances(),
    await projectionMatchesJournal(scope),
    await suspenseIsFlat(),
    await completedSettlementsAreProven(scope),
    await noLegPastItsBudget(scope),
    await everyEntryHasTwoSides(),
  ];
}

// ── I-1 ───────────────────────────────────────────────────────────────────────

async function trialBalanceBalances(): Promise<Check> {
  const rows = await trialBalance();
  const broken = rows.filter(r => !r.balanced);

  return {
    id: 'I-1',
    name: 'Trial balance is zero in every currency',
    passed: broken.length === 0,
    detail: broken.length
      ? broken.map(r => `${r.currency} residual ${r.residual.toString()}`).join('; ')
      : rows.map(r => `${r.currency} ✓`).join(' '),
  };
}

// ── I-4 ───────────────────────────────────────────────────────────────────────

async function projectionMatchesJournal(scope: Scope): Promise<Check> {
  const drifted: string[] = [];

  for (const userId of scope.userIds) {
    const accounts = await prisma.account.findMany({ where: { userId } });

    for (const account of accounts) {
      const code = `USER:${userId}:${account.currency.toUpperCase()}`;
      const ledger = await prisma.ledgerAccount.findUnique({ where: { code } });

      // USER accounts are credit-normal: negate the journal sum to get the
      // customer-facing positive balance.
      const journal = ledger
        ? (await prisma.journalLine.aggregate({ where: { accountId: ledger.id }, _sum: { amount: true } }))
            ._sum.amount?.negated() ?? ZERO
        : ZERO;

      if (!journal.sub(account.balance).abs().lessThanOrEqualTo(EPSILON)) {
        drifted.push(`${code}: journal ${journal.toString()} vs projection ${account.balance.toString()}`);
      }
    }
  }

  return {
    id: 'I-4',
    name: 'Account.balance agrees with the journal',
    passed: drifted.length === 0,
    detail: drifted.length ? drifted.join('; ') : `${scope.userIds.length} user(s) checked`,
  };
}

// ── I-3 ───────────────────────────────────────────────────────────────────────

async function suspenseIsFlat(): Promise<Check> {
  const accounts = await prisma.ledgerAccount.findMany({ where: { code: { startsWith: 'SUSPENSE:' } } });
  const nonZero: string[] = [];

  for (const account of accounts) {
    const sum =
      (await prisma.journalLine.aggregate({ where: { accountId: account.id }, _sum: { amount: true } }))._sum.amount ?? ZERO;
    if (!sum.abs().lessThanOrEqualTo(EPSILON)) nonZero.push(`${account.code} = ${sum.toString()}`);
  }

  return {
    id: 'I-3',
    name: 'Suspense is flat — nothing debited and undelivered',
    passed: nonZero.length === 0,
    detail: nonZero.length ? nonZero.join('; ') : `${accounts.length} suspense account(s) at zero`,
  };
}

// ── I-2 ───────────────────────────────────────────────────────────────────────

async function completedSettlementsAreProven(scope: Scope): Promise<Check> {
  const unproven: string[] = [];

  for (const [type, ids] of [
    ['Withdrawal', scope.withdrawalIds],
    ['BankDeposit', scope.depositIds],
  ] as const) {
    for (const id of ids) {
      const row =
        type === 'Withdrawal'
          ? await prisma.withdrawal.findUnique({ where: { id }, select: { status: true } })
          : await prisma.bankDeposit.findUnique({ where: { id }, select: { status: true } });

      if (row?.status !== 'COMPLETED') continue;

      const proof = await prisma.settlementProof.findFirst({
        where: { entityType: type, entityId: id, onchainError: null, commitment: 'finalized' },
      });
      if (!proof) unproven.push(`${type}:${id}`);
    }
  }

  return {
    id: 'I-2',
    name: 'Nothing is COMPLETED without a finalized on-chain proof',
    passed: unproven.length === 0,
    detail: unproven.length ? `no proof for ${unproven.join(', ')}` : 'every completed settlement carries a proof',
  };
}

// ── I-8 ───────────────────────────────────────────────────────────────────────

async function noLegPastItsBudget(scope: Scope): Promise<Check> {
  const ids = [...scope.depositIds, ...scope.withdrawalIds];
  if (ids.length === 0) return { id: 'I-8', name: 'No leg has exhausted its retries', passed: true, detail: 'no legs' };

  const legs = await prisma.settlementLeg.findMany({
    where: { entityId: { in: ids }, status: { in: ['FAILED', 'IN_FLIGHT'] } },
  });
  const exhausted = legs.filter(l => l.attempts >= l.maxAttempts);

  return {
    id: 'I-8',
    name: 'No leg has exhausted its retries',
    passed: exhausted.length === 0,
    detail: exhausted.length
      ? exhausted.map(l => `${l.entityType}:${l.entityId}#${l.sequence} ${l.kind} (${l.attempts} attempts)`).join('; ')
      : `${legs.length} leg(s) still open, all within budget`,
  };
}

// ── Structural ────────────────────────────────────────────────────────────────

/**
 * A one-sided entry cannot be created through `post`, so this catches a write
 * that reached the database another way — the same class of problem as an
 * unbalanced trial balance, found earlier.
 */
async function everyEntryHasTwoSides(): Promise<Check> {
  const entries = await prisma.journalEntry.findMany({ select: { id: true, postingKey: true, _count: { select: { lines: true } } } });
  const thin = entries.filter(e => e._count.lines < 2);

  return {
    id: 'S-1',
    name: 'Every journal entry has at least two sides',
    passed: thin.length === 0,
    detail: thin.length ? thin.map(e => e.postingKey).join(', ') : `${entries.length} entries`,
  };
}

// ── Reporting helpers ─────────────────────────────────────────────────────────

/** The postings a scenario produced, for the report. */
export async function postingsFor(entityType: string, entityId: string) {
  const entries = await prisma.journalEntry.findMany({
    where: { entityType, entityId },
    include: { lines: { include: { account: true } } },
    orderBy: { postedAt: 'asc' },
  });

  return entries.map(e => ({
    postingKey: e.postingKey,
    narrative: e.narrative,
    lines: e.lines.map(l => ({
      account: l.account.code,
      amount: l.amount.toString(),
      currency: l.currency,
    })),
  }));
}
