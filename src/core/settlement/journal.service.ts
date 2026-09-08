/**
 * Double-entry journal.
 *
 * The one rule: every posting balances to exactly zero, per currency, and that
 * is asserted in code before anything is written. A posting that does not
 * balance is a bug in the caller, and the correct response is to refuse it —
 * not to write it and discover the hole during an audit.
 *
 * Sign convention: **positive = debit, negative = credit**, in the line's own
 * currency. For a debit-normal account (ASSET, EXPENSE) a positive line
 * increases the balance; for a credit-normal account (LIABILITY, INCOME,
 * EQUITY) a positive line decreases it. `accounts.ts` owns that mapping so
 * callers never reason about it.
 *
 * Arithmetic is `Prisma.Decimal` throughout. The schema stores exact decimals
 * and the rest of this codebase reads them straight into JavaScript `number`,
 * which reintroduces the float error the schema was chosen to avoid. Nothing
 * in this file converts to `number`.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../ledger.service';
import { resolveAccount, isDebitNormal, type AccountType } from './accounts';
import { toUSD } from '../fx.service';

type TxClient = Prisma.TransactionClient;

export type JournalEventType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'P2P_TRANSFER'
  | 'INTERBANK'
  | 'FEE'
  | 'FX'
  | 'SETTLEMENT'
  | 'REVERSAL'
  | 'ADJUSTMENT'
  | 'RECONCILIATION';

export interface PostingLine {
  /** Account code — build it with `AccountCode.*`. */
  account: string;
  /**
   * Signed amount in `currency`. Positive debits, negative credits.
   * Accepts number for ergonomics but is converted to Decimal immediately;
   * prefer passing a Decimal or a string for anything derived from a balance.
   */
  amount: Prisma.Decimal | number | string;
  currency: string;
  memo?: string;
  /** Pre-computed USD value. Omit and it is derived via fx.service. */
  usdAmount?: Prisma.Decimal | number | string;
  userId?: string;
  bankId?: string;
}

export interface PostingRequest {
  eventType: JournalEventType;
  entityType: string;
  entityId: string;
  narrative: string;
  /**
   * Deterministic identity of this posting. Re-posting the same key is a
   * no-op that returns the existing entry, which is what makes the resume
   * worker safe to run repeatedly.
   *
   * Convention: `<entityType>:<entityId>:<step>` — e.g. `Withdrawal:ckx…:debit`.
   */
  postingKey: string;
  lines: PostingLine[];
  postedBy?: string;
  reversesId?: string;
}

export class UnbalancedPostingError extends Error {
  readonly code = 'UNBALANCED_POSTING';
  readonly statusCode = 500;
  constructor(postingKey: string, residuals: Record<string, string>) {
    super(
      `Refusing to post '${postingKey}': lines do not balance to zero. ` +
      `Residual by currency: ${Object.entries(residuals).map(([c, v]) => `${c}=${v}`).join(', ')}`,
    );
  }
}

/** Anything below this is rounding noise from an FX conversion, not a real hole. */
const EPSILON = new Prisma.Decimal('0.0000000001');

function dec(v: Prisma.Decimal | number | string): Prisma.Decimal {
  return v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);
}

/**
 * Assert the posting balances per currency.
 *
 * Per *currency*, not in USD: a cross-currency posting that balances only after
 * FX conversion is hiding an FX position. Those postings must name the
 * FX_PNL account explicitly, which forces the position to be visible.
 */
export function assertBalanced(postingKey: string, lines: PostingLine[]): void {
  const residual = new Map<string, Prisma.Decimal>();

  for (const line of lines) {
    const ccy = line.currency.toUpperCase();
    residual.set(ccy, (residual.get(ccy) ?? new Prisma.Decimal(0)).add(dec(line.amount)));
  }

  const breaks: Record<string, string> = {};
  for (const [ccy, sum] of residual) {
    if (sum.abs().greaterThan(EPSILON)) breaks[ccy] = sum.toString();
  }

  if (Object.keys(breaks).length > 0) {
    throw new UnbalancedPostingError(postingKey, breaks);
  }
}

/**
 * Post a balanced journal entry.
 *
 * MUST be called inside the same transaction as whatever state change it
 * records. Passing a `tx` is not optional for that reason — an entry committed
 * separately from the balance update it describes is precisely the failure
 * mode this exists to eliminate.
 */
export async function post(tx: TxClient, req: PostingRequest): Promise<{ id: string; created: boolean }> {
  if (req.lines.length < 2) {
    throw new Error(`Posting '${req.postingKey}' has ${req.lines.length} line(s); a posting needs at least two sides`);
  }

  assertBalanced(req.postingKey, req.lines);

  // Idempotent by postingKey — the resume worker replays steps by design.
  const existing = await tx.journalEntry.findUnique({ where: { postingKey: req.postingKey } });
  if (existing) return { id: existing.id, created: false };

  // Resolve USD values before opening the write, so an FX failure does not
  // leave a half-written entry.
  const resolved = await Promise.all(
    req.lines.map(async line => {
      const amount = dec(line.amount);
      const currency = line.currency.toUpperCase();
      const usdAmount =
        line.usdAmount !== undefined
          ? dec(line.usdAmount)
          : currency === 'USD'
            ? amount
            : new Prisma.Decimal(await toUSD(amount.toNumber(), currency));

      const account = await resolveAccount(tx, line.account, {
        currency,
        userId: line.userId,
        bankId: line.bankId,
      });

      return { line, amount, currency, usdAmount, account };
    }),
  );

  const entry = await tx.journalEntry.create({
    data: {
      eventType: req.eventType,
      entityType: req.entityType,
      entityId: req.entityId,
      narrative: req.narrative,
      postingKey: req.postingKey,
      postedBy: req.postedBy ?? 'system',
      reversesId: req.reversesId ?? null,
      lines: {
        create: resolved.map(r => ({
          accountId: r.account.id,
          amount: r.amount,
          currency: r.currency,
          usdAmount: r.usdAmount,
          memo: r.line.memo ?? null,
        })),
      },
    },
  });

  return { id: entry.id, created: true };
}

/**
 * Post the exact inverse of an existing entry.
 *
 * The journal is append-only, so a correction is a new entry, not an edit. The
 * reversal links back to the original via `reversesId` so both sides of the
 * correction are visible on a statement.
 */
export async function reverse(
  tx: TxClient,
  entryId: string,
  reason: string,
  postingKeySuffix = 'reversal',
): Promise<{ id: string; created: boolean }> {
  const original = await tx.journalEntry.findUniqueOrThrow({
    where: { id: entryId },
    include: { lines: { include: { account: true } } },
  });

  return post(tx, {
    eventType: 'REVERSAL',
    entityType: original.entityType,
    entityId: original.entityId,
    narrative: `Reversal of ${original.postingKey}: ${reason}`,
    postingKey: `${original.postingKey}:${postingKeySuffix}`,
    reversesId: original.id,
    lines: original.lines.map(l => ({
      account: l.account.code,
      amount: l.amount.negated(),
      currency: l.currency,
      usdAmount: l.usdAmount.negated(),
      memo: reason,
    })),
  });
}

// ── Reporting ─────────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  currency: string;
  debits: Prisma.Decimal;
  credits: Prisma.Decimal;
  residual: Prisma.Decimal;
  balanced: boolean;
}

/**
 * Trial balance: for each currency, total debits against total credits.
 *
 * On a correct set of books every residual is zero. A non-zero residual means
 * an unbalanced entry reached the database, which `post` should make
 * impossible — so a break here is evidence of a write that bypassed this
 * module, and is reported as CRITICAL.
 */
export async function trialBalance(asOf?: Date): Promise<TrialBalanceRow[]> {
  const where = asOf ? { entry: { postedAt: { lte: asOf } } } : {};

  const lines = await prisma.journalLine.findMany({
    where,
    select: { currency: true, amount: true },
  });

  const acc = new Map<string, { debits: Prisma.Decimal; credits: Prisma.Decimal }>();

  for (const l of lines) {
    const cur = acc.get(l.currency) ?? { debits: new Prisma.Decimal(0), credits: new Prisma.Decimal(0) };
    if (l.amount.isNegative()) cur.credits = cur.credits.add(l.amount.abs());
    else cur.debits = cur.debits.add(l.amount);
    acc.set(l.currency, cur);
  }

  return [...acc.entries()]
    .map(([currency, { debits, credits }]) => {
      const residual = debits.sub(credits);
      return { currency, debits, credits, residual, balanced: residual.abs().lessThanOrEqualTo(EPSILON) };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Statement lines for one account, newest first. */
export async function statement(accountCode: string, opts: { from?: Date; to?: Date; limit?: number } = {}) {
  const account = await prisma.ledgerAccount.findUnique({ where: { code: accountCode } });
  if (!account) return { account: accountCode, balance: new Prisma.Decimal(0), lines: [] };

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: account.id,
      ...(opts.from || opts.to
        ? { entry: { postedAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } }
        : {}),
    },
    include: { entry: true },
    orderBy: { entry: { postedAt: 'desc' } },
    take: opts.limit ?? 200,
  });

  const sign = isDebitNormal(account.type as AccountType) ? 1 : -1;
  const balance = lines.reduce((s, l) => s.add(l.amount), new Prisma.Decimal(0)).mul(sign);

  return {
    account: account.code,
    type: account.type,
    currency: account.currency,
    balance,
    lines: lines.map(l => ({
      postedAt: l.entry.postedAt,
      eventType: l.entry.eventType,
      narrative: l.entry.narrative,
      entityType: l.entry.entityType,
      entityId: l.entry.entityId,
      amount: l.amount,
      currency: l.currency,
      memo: l.memo,
    })),
  };
}
