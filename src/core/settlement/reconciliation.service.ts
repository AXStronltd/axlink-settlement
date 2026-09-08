/**
 * Reconciliation.
 *
 * Nothing in the system previously checked its own beliefs. `getBankStatement`
 * reported what the database said, and the database was the only witness.
 *
 * Five independent checks, each answering a different question:
 *
 *   1. TRIAL BALANCE      do the books balance at all?
 *   2. PROJECTION DRIFT   does `Account.balance` still equal the journal?
 *   3. CUSTODY            does our USDT position match the custodian's?
 *   4. ON-CHAIN           does the custodian's position match the chain?
 *   5. HYGIENE            is suspense flat, and is every settled transfer proven?
 *
 * 3 and 4 are separate on purpose. If the custodian agrees with us but the
 * chain disagrees with the custodian, the problem is at the custodian; if we
 * disagree with the custodian, the problem is ours. Collapsing them into one
 * check loses the ability to tell those apart.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../ledger.service';
import { trialBalance } from './journal.service';
import { getVaultAssetBalance } from '../../providers/live/fireblocks';
import { getTokenBalanceRaw, SOLANA_MINTS, formatUnits } from '../../providers/live/solana';

export type BreakSeverity = 'INFO' | 'WARN' | 'CRITICAL';

interface Break {
  kind: string;
  severity: BreakSeverity;
  subject: string;
  currency?: string;
  expected?: Prisma.Decimal;
  actual?: Prisma.Decimal;
  detail?: Prisma.InputJsonValue;
}

/**
 * Tolerance for position comparisons, as a fraction. Zero would be correct in
 * principle but flags every in-flight transfer, so the default allows a small
 * band and the run records the absolute delta regardless — the number matters
 * more than the pass/fail.
 */
const POSITION_TOLERANCE = Number(process.env.RECON_TOLERANCE ?? 0.0001);

export async function runReconciliation(
  kind: 'TRIAL_BALANCE' | 'CUSTODY' | 'ONCHAIN' | 'FULL' = 'FULL',
): Promise<{ runId: string; status: string; breaks: number; summary: Record<string, unknown> }> {
  const asOf = new Date();
  const run = await prisma.reconciliationRun.create({ data: { kind, asOf, status: 'RUNNING' } });

  const breaks: Break[] = [];
  const summary: Record<string, unknown> = {};

  try {
    if (kind === 'TRIAL_BALANCE' || kind === 'FULL') {
      summary.trialBalance = await checkTrialBalance(breaks);
      summary.projection = await checkProjectionDrift(breaks);
      summary.hygiene = await checkHygiene(breaks);
    }

    if (kind === 'CUSTODY' || kind === 'FULL') {
      summary.custody = await checkCustody(breaks);
    }

    if (kind === 'ONCHAIN' || kind === 'FULL') {
      summary.onchain = await checkOnChain(breaks);
    }

    const critical = breaks.filter(b => b.severity === 'CRITICAL').length;
    const status = breaks.length === 0 ? 'CLEAN' : 'BREAKS';

    await prisma.$transaction(async tx => {
      if (breaks.length > 0) {
        await tx.reconciliationBreak.createMany({
          data: breaks.map(b => ({
            runId: run.id,
            kind: b.kind,
            severity: b.severity,
            subject: b.subject,
            currency: b.currency ?? null,
            expected: b.expected ?? null,
            actual: b.actual ?? null,
            delta: b.expected && b.actual ? b.actual.sub(b.expected) : null,
            detail: b.detail ?? undefined,
          })),
        });
      }
      await tx.reconciliationRun.update({
        where: { id: run.id },
        data: { status, finishedAt: new Date(), breakCount: breaks.length, summary: summary as Prisma.InputJsonValue },
      });
    });

    if (critical > 0) {
      console.error(`[recon] ${critical} CRITICAL break(s) in run ${run.id} — books are not trustworthy until resolved`);
    }

    return { runId: run.id, status, breaks: breaks.length, summary };
  } catch (err) {
    await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: { status: 'ERROR', finishedAt: new Date(), summary: { error: String(err) } },
    });
    throw err;
  }
}

// ── 1. Trial balance ──────────────────────────────────────────────────────────

/**
 * `journal.post` refuses to write an unbalanced entry, so a break here means a
 * write reached the database without going through it. That is why this is
 * CRITICAL rather than WARN: it invalidates every other number in the system.
 */
async function checkTrialBalance(breaks: Break[]) {
  const rows = await trialBalance();

  for (const row of rows) {
    if (!row.balanced) {
      breaks.push({
        kind: 'UNBALANCED_ENTRY',
        severity: 'CRITICAL',
        subject: `trial-balance:${row.currency}`,
        currency: row.currency,
        expected: new Prisma.Decimal(0),
        actual: row.residual,
        detail: { debits: row.debits.toString(), credits: row.credits.toString() },
      });
    }
  }

  return rows.map(r => ({
    currency: r.currency,
    debits: r.debits.toString(),
    credits: r.credits.toString(),
    residual: r.residual.toString(),
    balanced: r.balanced,
  }));
}

// ── 2. Projection drift ───────────────────────────────────────────────────────

/**
 * `Account.balance` is a cache of the journal. They are written in the same
 * transaction, so they should never diverge — but the legacy `debit`/`credit`
 * helpers still exist and still write balances without posting, so until every
 * caller is migrated this check is the tripwire that catches one being used.
 */
async function checkProjectionDrift(breaks: Break[]) {
  const accounts = await prisma.account.findMany({ select: { userId: true, currency: true, balance: true } });
  let checked = 0;
  let drifted = 0;

  for (const account of accounts) {
    const code = `USER:${account.userId}:${account.currency.toUpperCase()}`;
    const ledger = await prisma.ledgerAccount.findUnique({ where: { code } });
    checked += 1;

    // USER accounts are credit-normal: journal sum is negated to get the
    // customer's positive balance.
    const journalBalance = ledger
      ? (
          await prisma.journalLine.aggregate({ where: { accountId: ledger.id }, _sum: { amount: true } })
        )._sum.amount?.negated() ?? new Prisma.Decimal(0)
      : new Prisma.Decimal(0);

    if (!journalBalance.equals(account.balance)) {
      drifted += 1;
      breaks.push({
        kind: 'PROJECTION_DRIFT',
        severity: 'CRITICAL',
        subject: code,
        currency: account.currency,
        expected: journalBalance,
        actual: account.balance,
        detail: { note: 'Account.balance disagrees with the journal — a write bypassed journal.post' },
      });
    }
  }

  return { checked, drifted };
}

// ── 3. Custody ────────────────────────────────────────────────────────────────

async function checkCustody(breaks: Break[]) {
  const custodyAccounts = await prisma.ledgerAccount.findMany({
    where: { code: { startsWith: 'CUSTODY:' } },
  });

  const results: Array<Record<string, string | boolean>> = [];

  for (const account of custodyAccounts) {
    const [, vaultId, asset] = account.code.split(':');

    const ledgerBalance =
      (await prisma.journalLine.aggregate({ where: { accountId: account.id }, _sum: { amount: true } }))._sum.amount ??
      new Prisma.Decimal(0);

    let custodianBalance: Prisma.Decimal;
    try {
      const fbAsset = await getVaultAssetBalance(vaultId, process.env.FIREBLOCKS_USDT_ASSET ?? 'USDT_SOL');
      custodianBalance = new Prisma.Decimal((fbAsset as { total?: string }).total ?? '0');
    } catch (err) {
      breaks.push({
        kind: 'CUSTODY_MISMATCH',
        severity: 'WARN',
        subject: account.code,
        currency: asset,
        detail: { note: 'could not read custodian balance', error: String(err) },
      });
      continue;
    }

    const within = withinTolerance(ledgerBalance, custodianBalance);
    if (!within) {
      breaks.push({
        kind: 'CUSTODY_MISMATCH',
        severity: 'CRITICAL',
        subject: account.code,
        currency: asset,
        expected: ledgerBalance,
        actual: custodianBalance,
        detail: { vaultId, note: 'our books and the custodian disagree' },
      });
    }

    results.push({
      account: account.code,
      ledger: ledgerBalance.toString(),
      custodian: custodianBalance.toString(),
      match: within,
    });
  }

  return results;
}

// ── 4. On chain ───────────────────────────────────────────────────────────────

/**
 * The only check that does not depend on any party we have a relationship with.
 * Compares what the chain says an address holds against what we and the
 * custodian believe. Configure `RECON_ONCHAIN_ADDRESSES` as
 * `label=address,label=address`.
 */
async function checkOnChain(breaks: Break[]) {
  const config = process.env.RECON_ONCHAIN_ADDRESSES ?? '';
  if (!config.trim()) return { skipped: 'RECON_ONCHAIN_ADDRESSES not configured' };

  const asset = (process.env.RECON_ONCHAIN_ASSET ?? 'USDT') as keyof typeof SOLANA_MINTS;
  const mintInfo = SOLANA_MINTS[asset];
  const results: Array<Record<string, string | boolean>> = [];

  for (const pair of config.split(',').map(s => s.trim()).filter(Boolean)) {
    const [label, address] = pair.split('=').map(s => s.trim());
    if (!address) continue;

    try {
      const raw = await getTokenBalanceRaw(address, mintInfo.mint);
      const onchain = new Prisma.Decimal(formatUnits(raw, mintInfo.decimals));

      const ledgerAccount = await prisma.ledgerAccount.findUnique({
        where: { code: `CUSTODY:${label}:${asset}` },
      });
      const ledger = ledgerAccount
        ? (await prisma.journalLine.aggregate({ where: { accountId: ledgerAccount.id }, _sum: { amount: true } }))
            ._sum.amount ?? new Prisma.Decimal(0)
        : new Prisma.Decimal(0);

      const match = withinTolerance(ledger, onchain);
      if (!match) {
        breaks.push({
          kind: 'ONCHAIN_MISMATCH',
          severity: 'CRITICAL',
          subject: `${label} (${address})`,
          currency: asset,
          expected: ledger,
          actual: onchain,
          detail: { address, mint: mintInfo.mint },
        });
      }

      results.push({ label, address, ledger: ledger.toString(), onchain: onchain.toString(), match });
    } catch (err) {
      breaks.push({
        kind: 'ONCHAIN_MISMATCH',
        severity: 'WARN',
        subject: `${label} (${address})`,
        detail: { note: 'could not read on-chain balance', error: String(err) },
      });
    }
  }

  return results;
}

// ── 5. Hygiene ────────────────────────────────────────────────────────────────

async function checkHygiene(breaks: Break[]) {
  // Suspense must be flat. A non-zero balance means a withdrawal was debited
  // from a customer and never delivered — the exact failure the leg state
  // machine is meant to make impossible, so a break here is a live incident.
  const suspense = await prisma.ledgerAccount.findMany({ where: { code: { startsWith: 'SUSPENSE:' } } });
  const suspenseBalances: Record<string, string> = {};

  for (const account of suspense) {
    const sum =
      (await prisma.journalLine.aggregate({ where: { accountId: account.id }, _sum: { amount: true } }))._sum.amount ??
      new Prisma.Decimal(0);
    suspenseBalances[account.code] = sum.toString();

    if (!sum.isZero()) {
      breaks.push({
        kind: 'SUSPENSE_NONZERO',
        severity: 'WARN',
        subject: account.code,
        currency: account.currency,
        expected: new Prisma.Decimal(0),
        actual: sum,
        detail: { note: 'withdrawals debited but not confirmed delivered' },
      });
    }
  }

  // Every completed settlement should carry an on-chain proof. One that does
  // not was marked settled on a custodian's word.
  const unproven = await prisma.withdrawal.findMany({
    where: {
      status: 'COMPLETED',
      id: { notIn: (await prisma.settlementProof.findMany({ where: { entityType: 'Withdrawal' }, select: { entityId: true } })).map(p => p.entityId) },
    },
    select: { id: true, trackingId: true, amount: true },
    take: 100,
  });

  for (const w of unproven) {
    breaks.push({
      kind: 'UNPROVEN_SETTLEMENT',
      severity: 'CRITICAL',
      subject: `Withdrawal:${w.trackingId}`,
      detail: { note: 'marked COMPLETED with no on-chain settlement proof', amount: w.amount.toString() },
    });
  }

  // Legs past their retry budget.
  const orphans = await prisma.settlementLeg.count({
    where: { status: { in: ['FAILED', 'IN_FLIGHT'] }, attempts: { gte: 5 } },
  });
  if (orphans > 0) {
    breaks.push({
      kind: 'ORPHAN_LEG',
      severity: 'WARN',
      subject: 'settlement-legs',
      detail: { count: orphans, note: 'legs exhausted their retries' },
    });
  }

  return { suspense: suspenseBalances, unprovenSettlements: unproven.length, orphanLegs: orphans };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function withinTolerance(expected: Prisma.Decimal, actual: Prisma.Decimal): boolean {
  if (expected.isZero() && actual.isZero()) return true;
  const denominator = expected.abs().greaterThan(0) ? expected.abs() : actual.abs();
  return actual.sub(expected).abs().div(denominator).lessThanOrEqualTo(POSITION_TOLERANCE);
}

/** Latest run plus its unresolved breaks. */
export async function latestRun(kind?: string) {
  const run = await prisma.reconciliationRun.findFirst({
    where: kind ? { kind } : {},
    orderBy: { startedAt: 'desc' },
    include: { breaks: { where: { resolvedAt: null }, orderBy: { severity: 'asc' } } },
  });
  return run;
}

/** Ops: mark a break resolved with a note explaining what was done. */
export async function resolveBreak(breakId: string, note: string) {
  return prisma.reconciliationBreak.update({
    where: { id: breakId },
    data: { resolvedAt: new Date(), resolvedNote: note },
  });
}
