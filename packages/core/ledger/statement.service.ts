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
import { journalBalance } from '../wallets/wallet.service';

export interface TenantScope { institutionId: string; environmentId: string }

/** Codes of every ledger account an institution may read in this environment. */
async function visibleAccountCodes(scope: TenantScope): Promise<string[]> {
  const wallets = await prisma.wallet.findMany({ where: scope, select: { custodyVaultId: true } });
  const assets = Object.values(ASSETS).filter(a => a.supported);
  const codes: string[] = [];
  for (const a of assets) {
    codes.push(AccountCode.institution(scope.institutionId, a.id));
    for (const w of wallets) codes.push(AccountCode.custody(w.custodyVaultId, a.id));
  }
  return codes;
}

export async function institutionBalances(scope: TenantScope) {
  const wallets = await prisma.wallet.findMany({ where: scope, select: { id: true, custodyVaultId: true } });
  const out = [];
  for (const a of Object.values(ASSETS).filter(x => x.supported)) {
    let total = new Prisma.Decimal(0);
    const byWallet = [];
    for (const w of wallets) { const b = await journalBalance(w, a.id); total = total.add(b); byWallet.push({ walletId: w.id, available: b.toFixed() }); }
    out.push({ asset: a.id, symbol: a.symbol, network: a.network, available: total.toFixed(), wallets: byWallet });
  }
  return { institutionId: scope.institutionId, asOf: new Date(), balances: out };
}

export interface EntriesQuery { limit?: number; cursor?: string; asset?: string; entityType?: string; entityId?: string }

/** Cursor = `<postedAt ISO>|<id>`; stable under concurrent postings because (postedAt, id) is a total order. */
function decodeCursor(c: string | undefined): { postedAt: Date; id: string } | null {
  if (!c) return null;
  const i = c.lastIndexOf('|'); if (i < 0) return null;
  const d = new Date(c.slice(0, i)); if (Number.isNaN(d.getTime())) return null;
  return { postedAt: d, id: c.slice(i + 1) };
}

export async function listInstitutionEntries(scope: TenantScope, q: EntriesQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const codes = await visibleAccountCodes(scope);
  const accounts = await prisma.ledgerAccount.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  const byId = new Map(accounts.map(a => [a.id, a.code]));
  if (accounts.length === 0) return { entries: [], nextCursor: null };
  const after = decodeCursor(q.cursor);
  const where: Prisma.JournalEntryWhereInput = {
    lines: { some: { accountId: { in: accounts.map(a => a.id) }, ...(q.asset ? { currency: q.asset.toUpperCase() } : {}) } },
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
