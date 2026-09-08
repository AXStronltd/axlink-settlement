/**
 * Chart of accounts.
 *
 * Account codes are structured strings rather than opaque ids so that a journal
 * line is readable without a join, and so that a statement query is a prefix
 * match. The builders below are the only supported way to construct a code —
 * hand-written strings drift, and a typo creates a *new* account that silently
 * absorbs money instead of failing.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../ledger.service';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

/** Debit-normal accounts increase with a positive line amount. */
const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set<AccountType>(['ASSET', 'EXPENSE']);

export function isDebitNormal(type: AccountType): boolean {
  return DEBIT_NORMAL.has(type);
}

// ── Code builders ─────────────────────────────────────────────────────────────

export const AccountCode = {
  /** What we owe a customer, per currency. */
  user: (userId: string, currency: string) => `USER:${userId}:${up(currency)}`,

  /** What we owe a member bank on the AxLink network. */
  bank: (bankId: string, currency: string) => `BANK:${bankId}:${up(currency)}`,

  /** Our own funds. */
  treasury: (currency: string) => `TREASURY:${up(currency)}`,

  /** Asset sitting in a named Fireblocks vault. */
  custody: (vaultId: string, asset: string) => `CUSTODY:${vaultId}:${up(asset)}`,

  /** Asset provably on Solana, keyed by SPL mint. */
  onchain: (mint: string) => `ONCHAIN:${mint}`,

  /** Funds sitting at a payout partner awaiting disbursement. */
  float: (providerId: string, currency: string) => `FLOAT:${providerId}:${up(currency)}`,

  /** Funds in transit at the fiat↔crypto converter (B2BinPay). */
  converter: (converterId: string, currency: string) => `CONVERTER:${converterId}:${up(currency)}`,

  /** Revenue. */
  feeIncome: (currency: string) => `FEE_INCOME:${up(currency)}`,

  /** Realised FX gain/loss. */
  fxPnl: (currency: string) => `FX_PNL:${up(currency)}`,

  /**
   * Known-unknown. Money we have identified but cannot yet attribute.
   * Asserted flat at end of day by reconciliation — a suspense balance that
   * survives a close is an operational incident, not an accounting detail.
   */
  suspense: (currency: string) => `SUSPENSE:${up(currency)}`,
} as const;

function up(s: string): string {
  return s.toUpperCase();
}

// ── Type inference from code ──────────────────────────────────────────────────

const PREFIX_TYPE: Record<string, AccountType> = {
  USER: 'LIABILITY',       // we owe the customer their balance
  BANK: 'LIABILITY',       // we owe the member bank its position
  TREASURY: 'ASSET',
  CUSTODY: 'ASSET',
  ONCHAIN: 'ASSET',
  FLOAT: 'ASSET',          // our money, held at a partner
  CONVERTER: 'ASSET',      // our money, in transit at the converter
  FEE_INCOME: 'INCOME',
  FX_PNL: 'INCOME',
  SUSPENSE: 'LIABILITY',
};

const TRANSIENT_PREFIXES = new Set(['SUSPENSE', 'CONVERTER']);

export function accountTypeFor(code: string): AccountType {
  const prefix = code.split(':', 1)[0];
  const type = PREFIX_TYPE[prefix];
  if (!type) {
    throw new Error(
      `Unknown account code prefix '${prefix}' in '${code}'. ` +
      `Build codes with AccountCode.* — a free-form code creates a new account ` +
      `that will silently absorb money.`,
    );
  }
  return type;
}

// ── Resolution ────────────────────────────────────────────────────────────────

type TxClient = Prisma.TransactionClient;

/**
 * Resolve a code to a `LedgerAccount`, creating it on first use.
 *
 * Accounts are created lazily rather than seeded because the set is open —
 * a new user, a new vault or a new partner each imply new accounts — but the
 * *shape* is closed: `accountTypeFor` rejects anything that is not a known
 * prefix, so a typo raises rather than opening an account.
 */
export async function resolveAccount(
  tx: TxClient,
  code: string,
  opts: { currency?: string; userId?: string; bankId?: string } = {},
): Promise<{ id: string; code: string; type: AccountType; currency: string }> {
  const existing = await tx.ledgerAccount.findUnique({ where: { code } });
  if (existing) {
    return {
      id: existing.id,
      code: existing.code,
      type: existing.type as AccountType,
      currency: existing.currency,
    };
  }

  const parts = code.split(':');
  const prefix = parts[0];
  const type = accountTypeFor(code);
  // Currency/asset is the final segment for every code shape except ONCHAIN,
  // whose final segment is a mint address.
  const currency = opts.currency ?? (prefix === 'ONCHAIN' ? 'USDC' : parts[parts.length - 1]);

  const created = await tx.ledgerAccount.create({
    data: {
      code,
      type,
      currency: currency.toUpperCase(),
      userId: opts.userId ?? (prefix === 'USER' ? parts[1] : null),
      bankId: opts.bankId ?? (prefix === 'BANK' ? parts[1] : null),
      transient: TRANSIENT_PREFIXES.has(prefix),
    },
  });

  return { id: created.id, code: created.code, type: created.type as AccountType, currency: created.currency };
}

/**
 * Balance of one account, derived from the journal.
 *
 * Returned in the account's natural sign: positive means "this account holds
 * value" for a debit-normal account, and equally for a credit-normal one — so
 * a customer with $100 reads as +100, not -100.
 */
export async function accountBalance(code: string): Promise<Prisma.Decimal> {
  const account = await prisma.ledgerAccount.findUnique({ where: { code } });
  if (!account) return new Prisma.Decimal(0);

  const agg = await prisma.journalLine.aggregate({
    where: { accountId: account.id },
    _sum: { amount: true },
  });

  const signed = agg._sum.amount ?? new Prisma.Decimal(0);
  return isDebitNormal(account.type as AccountType) ? signed : signed.negated();
}

/** Per-currency totals across every account of a type. Used by reconciliation. */
export async function balancesByType(type: AccountType): Promise<Record<string, Prisma.Decimal>> {
  const accounts = await prisma.ledgerAccount.findMany({ where: { type }, select: { id: true, currency: true } });
  if (accounts.length === 0) return {};

  const grouped = await prisma.journalLine.groupBy({
    by: ['currency'],
    where: { accountId: { in: accounts.map(a => a.id) } },
    _sum: { amount: true },
  });

  const sign = isDebitNormal(type) ? 1 : -1;
  return Object.fromEntries(
    grouped.map(g => [
      g.currency,
      (g._sum.amount ?? new Prisma.Decimal(0)).mul(sign),
    ]),
  );
}
