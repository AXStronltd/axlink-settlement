/**
 * Institution statement (Step 2, slice 4): the journal as one institution is allowed to see it.
 *
 * An institution owns, in one API environment, the CUSTODY:<vault>:<ASSET> accounts of its wallets
 * and the INSTITUTION:<id>:<ASSET> liability accounts. `GET /v1/ledger/entries` returns the journal
 * entries that touch those accounts, with only the lines on those accounts — never another tenant's
 * side of a posting. `GET /v1/balances` sums the wallets' journal balances per asset.
 */
import { Prisma } from '@prisma/client';
import { prisma } from './ledger.service';
import { AccountCode } from './accounts';
import { ASSETS } from '../assets/registry';
import { ApiError } from '../../shared/errors';

export interface TenantScope { institutionId: string; environmentId: string }

const SUPPORTED = () => Object.values(ASSETS).filter(a => a.supported);

/**
 * Accounts an institution may read in ONE environment. Selection is by the CUSTODY accounts of this
 * environment's wallets only: the INSTITUTION:<id>:<ASSET> liability account is keyed by institution,
 * not environment, so selecting by it would let a SANDBOX key read PRODUCTION postings. Its lines are
 * displayed when they sit on an entry that was selected through a custody account.
 */
async function visibleAccounts(scope: TenantScope) {
  const wallets = await prisma.wallet.findMany({ where: scope, select: { custodyVaultId: true } });
  const custodyCodes = wallets.flatMap(w => SUPPORTED().map(a => AccountCode.custody(w.custodyVaultId, a.id)));
  const displayCodes = SUPPORTED().map(a => AccountCode.institution(scope.institutionId, a.id));
  const accounts = await prisma.ledgerAccount.findMany({ where: { code: { in: [...custodyCodes, ...displayCodes] } }, select: { id: true, code: true } });
  const custodySet = new Set(custodyCodes);
  return { selectIds: accounts.filter(a => custodySet.has(a.code)).map(a => a.id), codeById: new Map(accounts.map(a => [a.id, a.code])) };
}

/** Balances per asset across the environment's wallets: one account lookup + one grouped sum, however many wallets. */
export async function institutionBalances(scope: TenantScope) {
  const wallets = await prisma.wallet.findMany({ where: scope, select: { id: true, custodyVaultId: true }, orderBy: { createdAt: 'asc' } });
  const codes = wallets.flatMap(w => SUPPORTED().map(a => AccountCode.custody(w.custodyVaultId, a.id)));
  const accounts = codes.length ? await prisma.ledgerAccount.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } }) : [];
  const sums = accounts.length ? await prisma.journalLine.groupBy({ by: ['accountId'], where: { accountId: { in: accounts.map(a => a.id) } }, _sum: { amount: true } }) : [];
  const byCode = new Map<string, Prisma.Decimal>();
  for (const s of sums) { const code = accounts.find(a => a.id === s.accountId)!.code; byCode.set(code, s._sum.amount ?? new Prisma.Decimal(0)); }
  const out = SUPPORTED().map(a => {
    let total = new Prisma.Decimal(0);
    const byWallet = wallets.map(w => { const b = byCode.get(AccountCode.custody(w.custodyVaultId, a.id)) ?? new Prisma.Decimal(0); total = total.add(b); return { walletId: w.id, available: b.toFixed() }; });
    return { asset: a.id, symbol: a.symbol, network: a.network, available: total.toFixed(), wallets: byWallet };
  });
  return { institutionId: scope.institutionId, asOf: new Date(), balances: out };
}

export interface EntriesQuery { limit?: number; cursor?: string; asset?: string; entityType?: string; entityId?: string }

/** Cursor = `<postedAt ISO>|<id>`; stable under concurrent postings because (postedAt, id) is a total order. */
function decodeCursor(c: string | undefined): { postedAt: Date; id: string } | null {
  if (!c) return null;
  const i = c.lastIndexOf('|');
  const d = i > 0 ? new Date(c.slice(0, i)) : new Date(NaN);
  // A mangled cursor must not silently restart at page 1 (a client would loop forever).
  if (i <= 0 || Number.isNaN(d.getTime()) || !c.slice(i + 1)) throw new ApiError('INVALID_CURSOR', 'cursor is not one this API issued; pass nextCursor verbatim (URL-encoded)', 400);
  return { postedAt: d, id: c.slice(i + 1) };
}

export async function listInstitutionEntries(scope: TenantScope, q: EntriesQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const after = decodeCursor(q.cursor);
  const { selectIds, codeById: byId } = await visibleAccounts(scope);
  if (selectIds.length === 0) return { entries: [], nextCursor: null };
  const where: Prisma.JournalEntryWhereInput = {
    lines: { some: { accountId: { in: selectIds }, ...(q.asset ? { currency: q.asset.toUpperCase() } : {}) } },
    ...(q.entityType ? { entityType: q.entityType } : {}), ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(after ? { OR: [{ postedAt: { lt: after.postedAt } }, { postedAt: after.postedAt, id: { lt: after.id } }] } : {}),
  };
  const rows = await prisma.journalEntry.findMany({ where, include: { lines: true }, orderBy: [{ postedAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
  const page = rows.slice(0, limit);
  const entries = page.map(e => ({
    id: e.id, postedAt: e.postedAt, eventType: e.eventType, entityType: e.entityType, entityId: e.entityId, narrative: e.narrative, reversesId: e.reversesId,
    lines: e.lines.filter(l => byId.has(l.accountId)).map(l => ({ account: byId.get(l.accountId)!, asset: l.currency, amount: l.amount.toFixed(), memo: l.memo })),
  }));
  const last = page[page.length - 1];
  return { entries, nextCursor: rows.length > limit && last ? `${last.postedAt.toISOString()}|${last.id}` : null };
}
