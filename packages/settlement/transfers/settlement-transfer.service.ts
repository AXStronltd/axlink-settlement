/**
 * Outbound settlement transfers (Step 2, slice 5) — money leaving an institution's custody vault
 * to an ACTIVE counterparty, in USDC or USDT on Solana.
 *
 * Lifecycle (every arrow is one short transaction; the sweeper drives the rest):
 *
 *   create ──policy──▶ AWAITING_APPROVAL ──operator──▶ APPROVED ──custody──▶ SUBMITTED ──▶ CONFIRMED ──finality──▶ SETTLED
 *                 └──auto (sandbox, under limit)──▶ APPROVED                      └──▶ FAILED (journal reversed)
 *
 * Rules that must hold:
 *   - Nothing leaves a vault before the journal says so: the CUSTODY−/INSTITUTION+ posting is written
 *     at APPROVED, before the custodian is called. A crash between the two is recoverable because the
 *     custodian dedupes on `externalTxId = transfer.id` and the sweeper re-submits APPROVED rows.
 *   - Available balance = journal balance of the custody account minus transfers still awaiting
 *     approval (they are not yet posted). A transfer never overdraws.
 *   - PRODUCTION always needs an operator approval, and only when OUTBOUND_SETTLEMENT_ENABLED=true;
 *     this deployment is not authorised to move live funds until that flag is set deliberately.
 *   - SETTLED means a Solana node reported the signature finalized and the token movement to the
 *     counterparty matched (asset mint, exact amount). In sandbox the custody stub has no chain, so
 *     the proof is recorded as SANDBOX_SIMULATED and the status says so.
 */
import { Prisma, type SettlementTransfer, type Counterparty } from '@prisma/client';
import { prisma } from '../../core/ledger/ledger.service';
import { getAsset, toMinorUnits, isAssetId } from '../../core/assets/registry';
import { AccountCode } from '../../core/ledger/accounts';
import { post, reverse } from '../../core/ledger/journal.service';
import { getWallet, journalBalance, applyWalletCredit } from '../../core/wallets/wallet.service';
import { providers } from '../../providers/registry/provider-registry';
import { proveSettlement, proofsFor, ProofMismatchError, SettlementNotFinalError } from '../proof/proof.service';
import { ApiError } from '../../shared/errors';
import { log } from '../../shared/logger';
import { getCounterparty, settlementWalletFor } from './counterparty.service';
import { raiseException } from '../operations/exception.service';

export interface Scope { institutionId: string; environmentId: string; environmentKind: 'SANDBOX' | 'PRODUCTION' }
const where = (s: { institutionId: string; environmentId: string }) => ({ institutionId: s.institutionId, environmentId: s.environmentId });

const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
export const policyLimits = () => ({
  maxPerTransfer: new Prisma.Decimal(num('TRANSFER_MAX_AMOUNT', 1_000_000)),
  dailyLimit: new Prisma.Decimal(num('TRANSFER_DAILY_LIMIT', 5_000_000)),
  maxPerHour: num('TRANSFER_MAX_PER_HOUR', 200),
  sandboxAutoApproveUpTo: new Prisma.Decimal(num('TRANSFER_AUTO_APPROVE_LIMIT_SANDBOX', 100_000)),
  maxSubmitAttempts: num('TRANSFER_MAX_SUBMIT_ATTEMPTS', 5),
});
/** Deployment defaults, overridable per API environment by operations (ApiEnvironment.transfer*). */
export async function effectiveLimits(environmentId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const d = policyLimits();
  const env = await db.apiEnvironment.findUnique({ where: { id: environmentId }, select: { transferDailyLimit: true, transferMaxPerHour: true, transferMaxAmount: true } });
  return { ...d, maxPerTransfer: env?.transferMaxAmount ?? d.maxPerTransfer, dailyLimit: env?.transferDailyLimit ?? d.dailyLimit, maxPerHour: env?.transferMaxPerHour ?? d.maxPerHour };
}
const COUNTED: SettlementTransfer['status'][] = ['AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'UNDER_REVIEW', 'SETTLED'];
/**
 * Velocity: what this institution has already committed to send today (UTC) in this asset, and how
 * many transfers it created in the last hour — across all its wallets in the environment. Taken under
 * an advisory lock keyed on (environment, asset) so two concurrent creates cannot both squeeze under the cap.
 */
async function velocityCheck(tx: Prisma.TransactionClient, scope: { environmentId: string }, assetId: string, amount: Prisma.Decimal, limits: Awaited<ReturnType<typeof effectiveLimits>>, checks: Record<string, unknown>) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scope.environmentId + ':' + assetId}))`;
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const today = (await tx.settlementTransfer.aggregate({ where: { environmentId: scope.environmentId, assetId, status: { in: COUNTED }, createdAt: { gte: dayStart } }, _sum: { amount: true } }))._sum.amount ?? new Prisma.Decimal(0);
  const lastHour = await tx.settlementTransfer.count({ where: { environmentId: scope.environmentId, status: { in: COUNTED }, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
  checks.dailyLimit = limits.dailyLimit.toFixed(); checks.sentToday = today.toFixed(); checks.maxPerHour = limits.maxPerHour; checks.createdLastHour = lastHour;
  if (today.add(amount).gt(limits.dailyLimit)) throw new ApiError('POLICY_DAILY_LIMIT', `today's outbound in this asset would reach ${today.add(amount).toFixed()}, above the daily limit of ${limits.dailyLimit.toFixed()}; ask operations to raise it`, 422, checks);
  if (lastHour >= limits.maxPerHour) throw new ApiError('POLICY_VELOCITY', `more than ${limits.maxPerHour} transfers created in the last hour; slow down or ask operations to raise the limit`, 429, checks);
}
export const outboundEnabled = (kind: 'SANDBOX' | 'PRODUCTION') => kind === 'SANDBOX' || process.env.OUTBOUND_SETTLEMENT_ENABLED === 'true';

const OPEN_RESERVING: SettlementTransfer['status'][] = ['AWAITING_APPROVAL'];

/**
 * Serialise every balance-changing decision on one wallet. Two concurrent creates (or a create and an
 * operator approve) must not both read the same available balance: the row lock makes the second wait
 * for the first commit and re-read. Defence in depth: `assertNotOverdrawn` re-reads the journal after
 * the posting and aborts the transaction if the custody account went negative.
 */
async function lockWallet(tx: Prisma.TransactionClient, walletId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${walletId} FOR UPDATE`;
}
async function assertNotOverdrawn(tx: Prisma.TransactionClient, wallet: { custodyVaultId: string }, assetId: string): Promise<void> {
  const after = await journalBalance(wallet, assetId, tx);
  if (after.isNegative()) throw new ApiError('INSUFFICIENT_BALANCE', `posting would overdraw the custody account (${after.toFixed()} ${assetId})`, 422);
}

/** Journal balance of the wallet asset minus transfers awaiting approval (not yet posted). */
export async function availableForTransfer(wallet: { id: string; custodyVaultId: string }, assetId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const posted = await journalBalance(wallet, assetId, db);
  const reserved = (await db.settlementTransfer.aggregate({ where: { walletId: wallet.id, assetId, status: { in: OPEN_RESERVING } }, _sum: { amount: true } }))._sum.amount ?? new Prisma.Decimal(0);
  return { posted, reserved, available: posted.sub(reserved) };
}

export interface CreateTransferInput { walletId: string; counterpartyId: string; asset: string; amount: string; reference?: string; idempotencyKey: string }

export async function createTransfer(scope: Scope, input: CreateTransferInput): Promise<{ transfer: SettlementTransfer; replayed: boolean }> {
  if (!outboundEnabled(scope.environmentKind)) throw new ApiError('OUTBOUND_DISABLED', 'outbound settlement is not enabled for PRODUCTION on this deployment (OUTBOUND_SETTLEMENT_ENABLED)', 503);
  if (!isAssetId(input.asset)) throw new ApiError('UNSUPPORTED_ASSET', `asset ${input.asset} is not supported`, 400);
  const asset = getAsset(input.asset);
  let amount: Prisma.Decimal;
  try { amount = new Prisma.Decimal(input.amount); toMinorUnits(amount, asset); } catch { throw new ApiError('INVALID_AMOUNT', `amount must be a decimal with at most ${asset.decimals} places`, 400); }
  if (!amount.isPositive() || amount.isZero()) throw new ApiError('INVALID_AMOUNT', 'amount must be positive', 400);

  // Idempotent on (environment, key): same request → same transfer; different request under the same key → 409.
  const existing = await prisma.settlementTransfer.findUnique({ where: { environmentId_idempotencyKey: { environmentId: scope.environmentId, idempotencyKey: input.idempotencyKey } } });
  if (existing) {
    const same = existing.walletId === input.walletId && existing.counterpartyId === input.counterpartyId && existing.assetId === asset.id && existing.amount.equals(amount) && (existing.reference ?? null) === (input.reference ?? null);
    if (!same) throw new ApiError('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used for a different request', 409, { transferId: existing.id });
    return { transfer: existing, replayed: true };
  }

  const wallet = await getWallet(input.walletId, { institutionId: scope.institutionId, environmentId: scope.environmentId });
  if (wallet.status !== 'ACTIVE') throw new ApiError('WALLET_NOT_ACTIVE', `wallet is ${wallet.status}`, 409);
  if (wallet.network !== asset.network) throw new ApiError('ASSET_NETWORK_MISMATCH', `${asset.id} is on ${asset.network}; wallet is on ${wallet.network}`, 400);
  const cp = await getCounterparty(input.counterpartyId, { institutionId: scope.institutionId, environmentId: scope.environmentId });
  if (cp.status !== 'ACTIVE') throw new ApiError('COUNTERPARTY_NOT_ACTIVE', `counterparty is ${cp.status}`, 409);
  if (cp.network !== asset.network) throw new ApiError('COUNTERPARTY_NETWORK_MISMATCH', `counterparty is on ${cp.network}`, 400);

  const limits = await effectiveLimits(scope.environmentId);
  const checks: Record<string, unknown> = { maxPerTransfer: limits.maxPerTransfer.toFixed(), counterparty: cp.status, counterpartyKind: cp.kind, custodyWhitelisted: cp.custodyWhitelisted, screening: (cp.screening as { verdict?: string } | null)?.verdict ?? null };
  if (amount.gt(limits.maxPerTransfer)) throw new ApiError('POLICY_LIMIT', `amount exceeds the per-transfer limit of ${limits.maxPerTransfer.toFixed()} ${asset.symbol}`, 422, checks);

  try {
    const transfer = await prisma.$transaction(async tx => {
      await lockWallet(tx, wallet.id);
      await velocityCheck(tx, scope, asset.id, amount, limits, checks);
      const bal = await availableForTransfer(wallet, asset.id, tx);
      checks.available = bal.available.toFixed(); checks.reserved = bal.reserved.toFixed();
      if (bal.available.lt(amount)) throw new ApiError('INSUFFICIENT_BALANCE', `available ${bal.available.toFixed()} ${asset.symbol} is less than ${amount.toFixed()}`, 422, checks);
      const auto = scope.environmentKind === 'SANDBOX' && amount.lte(limits.sandboxAutoApproveUpTo);
      checks.approval = auto ? 'auto (sandbox, under limit)' : 'operator';
      const t = await tx.settlementTransfer.create({ data: {
        institutionId: scope.institutionId, environmentId: scope.environmentId, walletId: wallet.id, counterpartyId: cp.id, assetId: asset.id, amount,
        reference: input.reference ?? null, idempotencyKey: input.idempotencyKey, policy: checks as Prisma.InputJsonValue,
      } });
      return auto ? approveInTx(tx, t, wallet, 'sandbox-auto') : t;
    });
    log.info('transfer.created', { institutionId: scope.institutionId, transferId: transfer.id, status: transfer.status, asset: asset.id });
    return { transfer, replayed: false };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const won = await prisma.settlementTransfer.findUnique({ where: { environmentId_idempotencyKey: { environmentId: scope.environmentId, idempotencyKey: input.idempotencyKey } } });
      if (won) return { transfer: won, replayed: true };
    }
    throw e;
  }
}

/** APPROVED = journaled. The posting is the reservation; from here the money is committed. */
async function approveInTx(tx: Prisma.TransactionClient, t: SettlementTransfer, wallet: { custodyVaultId: string }, by: string): Promise<SettlementTransfer> {
  // The counterparty or wallet may have changed since the request was made (disabled, suspended,
  // rejected by an operator). Nothing is posted for a destination that is no longer approved.
  const [cp, w] = await Promise.all([tx.counterparty.findUnique({ where: { id: t.counterpartyId } }), tx.wallet.findUnique({ where: { id: t.walletId } })]);
  if (!cp || cp.status !== 'ACTIVE') throw new ApiError('COUNTERPARTY_NOT_ACTIVE', `counterparty is ${cp?.status ?? 'missing'}`, 409);
  if (!w || w.status !== 'ACTIVE') throw new ApiError('WALLET_NOT_ACTIVE', `wallet is ${w?.status ?? 'missing'}`, 409);
  // NETWORK: fix the receiving participant's wallet now, so the destination cannot drift between approval and submission.
  let receivingWalletId: string | null = null;
  if (cp.kind === 'NETWORK') {
    const env = await tx.apiEnvironment.findUnique({ where: { id: t.environmentId }, select: { kind: true } });
    const rw = cp.participantInstitutionId ? await settlementWalletFor(cp.participantInstitutionId, env!.kind, tx, { network: w.network, custodyProvider: w.custodyProvider }) : null;
    if (!rw) throw new ApiError('PARTICIPANT_NOT_READY', 'the receiving participant has no active wallet in this environment', 409);
    if (rw.id === t.walletId) throw new ApiError('PARTICIPANT_IS_SELF', 'source and destination wallet are the same', 400);
    receivingWalletId = rw.id;
  }
  const entry = await post(tx, {
    eventType: 'SETTLEMENT', entityType: 'SettlementTransfer', entityId: t.id, postingKey: `SettlementTransfer:${t.id}:debit`,
    narrative: `Outbound settlement ${t.assetId} ${t.amount.toFixed()} to counterparty ${t.counterpartyId} for institution ${t.institutionId}`,
    lines: [
      { account: AccountCode.custody(wallet.custodyVaultId, t.assetId), currency: t.assetId, amount: t.amount.negated(), usdAmount: t.amount.negated() },
      { account: AccountCode.institution(t.institutionId, t.assetId), currency: t.assetId, amount: t.amount, usdAmount: t.amount },
    ],
  });
  await applyWalletCredit(tx, t.walletId, t.assetId, t.amount.negated());
  await assertNotOverdrawn(tx, wallet, t.assetId);
  return tx.settlementTransfer.update({ where: { id: t.id }, data: { status: 'APPROVED', approvedBy: by, approvedAt: new Date(), journalEntryId: entry.id, receivingWalletId, nextAttemptAt: new Date() } });
}

export async function approveTransfer(id: string, by: string) {
  return prisma.$transaction(async tx => {
    const pre = await tx.settlementTransfer.findUnique({ where: { id }, select: { walletId: true, environment: { select: { kind: true } } } });
    if (!pre) throw new ApiError('NOT_FOUND', 'transfer not found', 404);
    if (!outboundEnabled(pre.environment.kind)) throw new ApiError('OUTBOUND_DISABLED', 'outbound settlement is not enabled for PRODUCTION on this deployment', 503);
    await lockWallet(tx, pre.walletId);
    const t = await tx.settlementTransfer.findUnique({ where: { id }, include: { wallet: true } });
    if (!t) throw new ApiError('NOT_FOUND', 'transfer not found', 404);
    if (t.status !== 'AWAITING_APPROVAL') throw new ApiError('NOT_AWAITING_APPROVAL', `transfer is ${t.status}`, 409);
    const bal = await availableForTransfer(t.wallet, t.assetId, tx);
    // Reserved includes this transfer; it must still fit.
    if (bal.available.add(t.amount).lt(t.amount)) throw new ApiError('INSUFFICIENT_BALANCE', `available ${bal.available.add(t.amount).toFixed()} is less than ${t.amount.toFixed()}`, 422);
    const r = await approveInTx(tx, t, t.wallet, by);
    log.info('transfer.approved', { transferId: id, by });
    return r;
  });
}

export async function rejectTransfer(id: string, by: string, reason: string) {
  return prisma.$transaction(async tx => {
    const r = await tx.settlementTransfer.updateMany({ where: { id, status: 'AWAITING_APPROVAL' }, data: { status: 'REJECTED', approvedBy: by, failureReason: `rejected by operator: ${reason}`.slice(0, 500) } });
    if (r.count !== 1) { const t = await tx.settlementTransfer.findUnique({ where: { id } }); if (!t) throw new ApiError('NOT_FOUND', 'transfer not found', 404); throw new ApiError('NOT_AWAITING_APPROVAL', `transfer is ${t.status}`, 409); }
    const t = (await tx.settlementTransfer.findUnique({ where: { id } }))!;
    await emit(t, 'transfer.failed', { reason: t.failureReason }, tx);
    return t;
  });
}

export async function cancelTransfer(id: string, scope: { institutionId: string; environmentId: string }) {
  const r = await prisma.settlementTransfer.updateMany({ where: { id, institutionId: scope.institutionId, environmentId: scope.environmentId, status: 'AWAITING_APPROVAL' }, data: { status: 'CANCELLED' } });
  if (r.count !== 1) { const t = await getTransfer(id, scope); throw new ApiError('NOT_CANCELLABLE', `transfer is ${t.status}; only AWAITING_APPROVAL transfers can be cancelled`, 409); }
}

export async function getTransfer(id: string, scope: { institutionId: string; environmentId: string }) {
  const t = await prisma.settlementTransfer.findFirst({ where: { id, institutionId: scope.institutionId, environmentId: scope.environmentId }, include: { counterparty: true } });
  if (!t) throw new ApiError('NOT_FOUND', 'transfer not found', 404);
  return t;
}
const STATUSES = ['AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'UNDER_REVIEW', 'SETTLED', 'FAILED', 'REJECTED', 'CANCELLED'] as const;
export function listTransfers(scope: { institutionId: string; environmentId: string }, status?: string) {
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new ApiError('VALIDATION_ERROR', `status must be one of ${STATUSES.join(', ')}`, 400);
  return prisma.settlementTransfer.findMany({ where: { ...where(scope), ...(status ? { status: status as typeof STATUSES[number] } : {}) }, orderBy: { createdAt: 'desc' }, take: 100, include: { counterparty: true } });
}
export function listUnderReview() { return prisma.settlementTransfer.findMany({ where: { status: 'UNDER_REVIEW' }, orderBy: { updatedAt: 'asc' }, include: { counterparty: true, institution: { select: { slug: true } }, environment: { select: { kind: true } } } }); }
export function listAwaitingApproval() { return prisma.settlementTransfer.findMany({ where: { status: 'AWAITING_APPROVAL' }, orderBy: { createdAt: 'asc' }, include: { counterparty: true, institution: { select: { slug: true } }, environment: { select: { kind: true } } } }); }

// ── Events ────────────────────────────────────────────────────────────────────
export type TransferEvent = 'transfer.submitted' | 'transfer.settled' | 'transfer.failed';
async function emit(t: SettlementTransfer & { counterparty?: Counterparty }, type: TransferEvent, extra: Record<string, unknown>, tx?: Prisma.TransactionClient) {
  const { emitInstitutionEvent } = await import('../../core/webhooks/webhook-endpoint.service');
  const data = { transferId: t.id, kind: 'TRANSFER', status: publicStatus(t), stage: t.status, walletId: t.walletId, counterpartyId: t.counterpartyId, asset: t.assetId, amount: t.amount.toFixed(), reference: t.reference, txHash: t.txHash, explorerUrl: t.txHash ? `https://solscan.io/tx/${t.txHash}` : null, ...extra } as Prisma.InputJsonValue;
  const run = (db: Prisma.TransactionClient) => emitInstitutionEvent(db, { institutionId: t.institutionId, environmentId: t.environmentId }, type as never, data, { entityType: 'SettlementTransfer', entityId: t.id });
  return tx ? run(tx) : prisma.$transaction(run);
}

// ── Submission to custody (sweeper) ───────────────────────────────────────────
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
const CLAIM_LEASE_MS = 120_000;
let sweeping = false;

/**
 * Submit APPROVED transfers to the custodian. Each row is CLAIMED first with a conditional update
 * (status APPROVED → SUBMITTING with a lease), so two instances or two overlapping sweeps cannot both
 * call custody for the same row. Before any (re)submission the custodian is asked whether it already
 * holds a transaction for this transfer id — a timeout after acceptance must adopt that transaction,
 * never pay again and never reverse the journal.
 */
export async function submitApprovedTransfers(limit = 50): Promise<{ submitted: number; failed: number; deferred: number }> {
  const now = new Date();
  const rows = await prisma.settlementTransfer.findMany({
    where: { OR: [
      { status: 'APPROVED', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { status: 'SUBMITTING', nextAttemptAt: { lte: now } }, // a lease that expired: the claimer died mid-call
    ] },
    include: { wallet: true, counterparty: true, environment: { select: { kind: true } } }, take: limit, orderBy: { approvedAt: 'asc' },
  });
  const out = { submitted: 0, failed: 0, deferred: 0 };
  const custody = providers.custody();
  for (const t of rows) {
    if (!outboundEnabled(t.environment.kind)) { log.error('transfer.outbound_disabled', { transferId: t.id, environment: t.environment.kind }); out.deferred++; continue; }
    // claim
    const claimed = await prisma.settlementTransfer.updateMany({ where: { id: t.id, status: t.status, nextAttemptAt: t.nextAttemptAt }, data: { status: 'SUBMITTING', nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS) } });
    if (claimed.count !== 1) continue; // someone else has it
    if (t.counterparty.status !== 'ACTIVE' || t.wallet.status !== 'ACTIVE') {
      // Nothing has left custody yet: this is a clean refusal, and the journal is restored.
      await failTransfer(t.id, `refused before submission: counterparty is ${t.counterparty.status}, wallet is ${t.wallet.status}`, undefined, t.attempts, 'SUBMITTING'); out.failed++; continue;
    }
    const asset = getAsset(t.assetId);
    try {
      // Recovery first: did an earlier attempt reach the custodian? (externalTxId = transfer id)
      let r: { providerTxId: string; status: 'PENDING' | 'CONFIRMED' | 'FAILED'; txHash?: string } | null = null;
      if (t.attempts > 0) {
        const existing = await custody.findTransferByClientRef(t.id);
        if (existing) { r = existing; log.warn('transfer.recovered_from_custody', { transferId: t.id, providerTxId: existing.providerTxId }); }
      }
      if (!r && t.counterparty.kind === 'NETWORK') {
        // Vault to vault inside AxLink custody: the receiving wallet was fixed at approval.
        const rw = t.receivingWalletId ? await prisma.wallet.findUnique({ where: { id: t.receivingWalletId } }) : null;
        if (!rw || rw.status !== 'ACTIVE') { await failTransfer(t.id, `refused before submission: receiving participant wallet is ${rw?.status ?? 'missing'}`, undefined, t.attempts, 'SUBMITTING'); out.failed++; continue; }
        r = await custody.transferInternal({ clientRef: t.id, fromVaultId: t.wallet.custodyVaultId, toVaultId: rw.custodyVaultId, asset: { symbol: asset.symbol, chain: asset.network }, amount: t.amount.toFixed() });
      }
      r ??= await custody.transferExternal({ clientRef: t.id, fromVaultId: t.wallet.custodyVaultId, toAddress: t.counterparty.address, asset: { symbol: asset.symbol, chain: asset.network }, amount: t.amount.toFixed(), memo: t.reference ?? `AxLink ${t.id}` });
      if (custody.configured() && /_sandbox_/.test(r.providerTxId)) throw Object.assign(new Error(`custodian returned a sandbox transaction id on a configured workspace: ${r.providerTxId}`), { retryable: false });
      const at = new Date();
      if (r.status === 'FAILED') {
        // The custodian refused outright (policy, insufficient fee, blocked). Nothing left the vault.
        await failTransfer(t.id, `custody rejected the transaction (${r.providerTxId})`, undefined, t.attempts + 1, 'SUBMITTING'); out.failed++; continue;
      }
      const data = { status: r.status === 'CONFIRMED' ? 'CONFIRMED' as const : 'SUBMITTED' as const, providerTxId: r.providerTxId, txHash: r.txHash ?? null, submittedAt: at, ...(r.status === 'CONFIRMED' ? { confirmedAt: at } : {}), attempts: t.attempts + 1, nextAttemptAt: null };
      await prisma.$transaction(async tx => {
        const c = await tx.settlementTransfer.updateMany({ where: { id: t.id, status: 'SUBMITTING' }, data });
        if (c.count !== 1) return;
        await emit({ ...t, ...data }, 'transfer.submitted', { providerTxId: r!.providerTxId }, tx);
      });
      out.submitted++;
    } catch (e) {
      const err = e as Error & { retryable?: boolean };
      const attempts = t.attempts + 1;
      // A terminal failure here is only declared when the custodian confirms it holds nothing for us.
      if (attempts >= policyLimits().maxSubmitAttempts || err.retryable === false) {
        let held = null; try { held = await custody.findTransferByClientRef(t.id); } catch { /* unknown: keep retrying rather than reverse */ }
        if (held) { await prisma.settlementTransfer.update({ where: { id: t.id }, data: { status: 'SUBMITTED', providerTxId: held.providerTxId, txHash: held.txHash ?? null, submittedAt: new Date(), attempts, nextAttemptAt: null } }); out.submitted++; continue; }
        if (err.retryable === false || attempts >= policyLimits().maxSubmitAttempts) { await failTransfer(t.id, `custody submission failed after ${attempts} attempts: ${err.message}`, undefined, attempts, 'SUBMITTING'); out.failed++; continue; }
      }
      await prisma.settlementTransfer.updateMany({ where: { id: t.id, status: 'SUBMITTING' }, data: { status: 'APPROVED', attempts, nextAttemptAt: new Date(Date.now() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]), failureReason: `attempt ${attempts}: ${err.message}`.slice(0, 500) } });
      log.warn('transfer.submit_retry', { transferId: t.id, attempts, message: err.message });
      out.deferred++;
    }
  }
  if (out.submitted || out.failed) log.info('transfer.submitted_batch', out);
  return out;
}

/** Custody's word on a submitted transfer: from a webhook (preferred) or the poller. Idempotent. */
export async function applyCustodyStatus(providerTxId: string, s: { status: 'PENDING' | 'CONFIRMED' | 'FAILED'; final: boolean; txHash?: string }, tx?: Prisma.TransactionClient): Promise<'updated' | 'ignored'> {
  const db = tx ?? prisma;
  const t = await db.settlementTransfer.findFirst({ where: { providerTxId, status: { in: ['SUBMITTED', 'CONFIRMED'] } } });
  if (!t) return 'ignored';
  if (s.status === 'FAILED' && s.final) {
    if (t.status === 'SUBMITTED' && !t.txHash && !s.txHash) { await failTransfer(t.id, 'custody reported the transaction failed/rejected before broadcast', tx); return 'updated'; }
    // Broadcast already happened (a signature exists): funds may have moved. Flag for a person; never reverse here.
    await moveToReview({ ...t, txHash: s.txHash ?? t.txHash }, 'custody reported FAILED after broadcast; on-chain outcome must be verified by operations', db);
    return 'updated';
  }
  if (s.status === 'CONFIRMED' && s.final && t.status === 'SUBMITTED') {
    await db.settlementTransfer.update({ where: { id: t.id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), txHash: s.txHash ?? t.txHash } });
    return 'updated';
  }
  if (s.txHash && !t.txHash) { await db.settlementTransfer.update({ where: { id: t.id }, data: { txHash: s.txHash } }); return 'updated'; }
  return 'ignored';
}

export async function pollSubmittedTransfers(limit = 50): Promise<{ confirmed: number; failed: number; pending: number }> {
  const rows = await prisma.settlementTransfer.findMany({ where: { status: 'SUBMITTED', providerTxId: { not: null } }, take: limit, orderBy: { submittedAt: 'asc' } });
  const out = { confirmed: 0, failed: 0, pending: 0 };
  for (const t of rows) {
    try {
      const s = await providers.custody().getTransfer(t.providerTxId!);
      const r = await applyCustodyStatus(t.providerTxId!, s);
      if (r === 'updated' && s.status === 'FAILED') out.failed++; else if (r === 'updated' && s.status === 'CONFIRMED') out.confirmed++; else out.pending++;
    } catch (e) { out.pending++; log.warn('transfer.poll_error', { transferId: t.id, message: (e as Error).message }); }
  }
  return out;
}

/** Terminal failure before or at custody: reverse the posting so the institution's balance is restored. */
export async function failTransfer(id: string, reason: string, tx?: Prisma.TransactionClient, attempts?: number, fromStatus?: SettlementTransfer['status']) {
  const run = async (db: Prisma.TransactionClient) => {
    const t = await db.settlementTransfer.findUnique({ where: { id } });
    if (!t || !['APPROVED', 'SUBMITTING', 'SUBMITTED'].includes(t.status)) return null; // CONFIRMED (broadcast) is never reversed automatically
    if (fromStatus && t.status !== fromStatus) return null;
    if (t.journalEntryId) {
      await reverse(db, t.journalEntryId, reason.slice(0, 200));
      await applyWalletCredit(db, t.walletId, t.assetId, t.amount);
    }
    const u = await db.settlementTransfer.update({ where: { id }, data: { status: 'FAILED', failureReason: reason.slice(0, 500), ...(attempts !== undefined ? { attempts } : {}) } });
    await emit(u, 'transfer.failed', { reason: u.failureReason }, db);
    log.error('transfer.failed', { transferId: id, reason });
    return u;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

/** The receiving participant's side of a network settlement: posted once (posting key), only at SETTLED. */
async function creditReceiver(tx: Prisma.TransactionClient, t: SettlementTransfer & { counterparty: Counterparty }, receiving: { id: string; custodyVaultId: string; institutionId: string; environmentId: string }, finality: string) {
  const credit = await post(tx, {
    eventType: 'SETTLEMENT', entityType: 'SettlementTransfer', entityId: t.id, postingKey: `SettlementTransfer:${t.id}:credit`,
    narrative: `Network settlement received ${t.assetId} ${t.amount.toFixed()} from institution ${t.institutionId} (transfer ${t.id})`,
    lines: [
      { account: AccountCode.custody(receiving.custodyVaultId, t.assetId), currency: t.assetId, amount: t.amount, usdAmount: t.amount },
      { account: AccountCode.institution(receiving.institutionId, t.assetId), currency: t.assetId, amount: t.amount.negated(), usdAmount: t.amount.negated() },
    ],
  });
  await applyWalletCredit(tx, receiving.id, t.assetId, t.amount);
  await tx.settlementTransfer.update({ where: { id: t.id }, data: { creditEntryId: credit.id } });
  const sender = await tx.institution.findUnique({ where: { id: t.institutionId }, select: { slug: true, legalName: true } });
  const { emitInstitutionEvent } = await import('../../core/webhooks/webhook-endpoint.service');
  await emitInstitutionEvent(tx, { institutionId: receiving.institutionId, environmentId: receiving.environmentId }, 'settlement.received' as never,
    { transferId: t.id, kind: 'NETWORK_SETTLEMENT', status: 'COMPLETED', walletId: receiving.id, asset: t.assetId, amount: t.amount.toFixed(), reference: t.reference, from: { participant: sender?.slug ?? null, name: sender?.legalName ?? null }, finality, txHash: t.txHash } as Prisma.InputJsonValue,
    { entityType: 'SettlementTransfer', entityId: t.id });
}

/**
 * UNDER_REVIEW: custody and the chain (or our own records) disagree after broadcast. The sweeper stops
 * touching the row, the institution hears once, and one CRITICAL exception waits for an operator who
 * decides with evidence (`reviewTransfer`). Nothing is reversed or credited until then.
 */
async function moveToReview(t: SettlementTransfer, reason: string, db?: Prisma.TransactionClient) {
  const run = async (tx: Prisma.TransactionClient) => {
    const c = await tx.settlementTransfer.updateMany({ where: { id: t.id, status: { in: ['SUBMITTED', 'CONFIRMED'] } }, data: { status: 'UNDER_REVIEW', failureReason: reason.slice(0, 500), txHash: t.txHash } });
    if (c.count !== 1) return;
    const u = (await tx.settlementTransfer.findUnique({ where: { id: t.id } }))!;
    await emit(u, 'transfer.failed', { attention: true, status: 'PROCESSING', reason: u.failureReason }, tx);
    log.error('transfer.under_review', { transferId: t.id, reason });
    return u;
  };
  const u = db ? await run(db) : await prisma.$transaction(run);
  // The queue item is written outside the money transaction: a unique-violation on a concurrent raise must
  // never abort the state change above, and the item is still raised on the next sweep if this write fails.
  if (u) await raiseException({ kind: 'TRANSFER_ATTENTION', severity: 'CRITICAL', subject: t.id, currency: t.assetId, expected: t.amount, detail: { reason: u.failureReason, txHash: u.txHash, previousStage: t.status }, institutionId: t.institutionId, entityType: 'SettlementTransfer', entityId: t.id }).catch(e => log.error('exception.raise_failed', { transferId: t.id, message: (e as Error).message }));
  return u;
}

/**
 * Operator decision on an UNDER_REVIEW transfer, with the evidence recorded on the exception:
 *   - 'settled': the operator verified on chain that the funds reached the recipient → SETTLED (and the
 *     receiver credited for a network settlement), proof row recorded as operator-attested;
 *   - 'failed': the operator verified the funds never left the vault → FAILED, journal reversed.
 */
export async function reviewTransfer(id: string, decision: 'settled' | 'failed', by: string, evidence: string) {
  if (!evidence.trim()) throw new ApiError('VALIDATION_ERROR', 'evidence is required (what was checked, where)', 400);
  return prisma.$transaction(async tx => {
    const t = await tx.settlementTransfer.findUnique({ where: { id }, include: { counterparty: true } });
    if (!t) throw new ApiError('NOT_FOUND', 'transfer not found', 404);
    if (t.status !== 'UNDER_REVIEW') throw new ApiError('NOT_UNDER_REVIEW', `transfer is ${t.status}`, 409);
    const { resolveOpenException } = await import('../operations/exception.service');
    if (decision === 'failed') {
      if (t.journalEntryId) { await reverse(tx, t.journalEntryId, `operator review: ${evidence}`.slice(0, 200)); await applyWalletCredit(tx, t.walletId, t.assetId, t.amount); }
      const u = await tx.settlementTransfer.update({ where: { id }, data: { status: 'FAILED', failureReason: `operator review (${by}): funds did not leave custody — ${evidence}`.slice(0, 500) } });
      await emit(u, 'transfer.failed', { reason: u.failureReason }, tx);
      await resolveOpenException('TRANSFER_ATTENTION', id, t.assetId, by, `decided FAILED: ${evidence}`, tx);
      log.warn('transfer.review_failed', { transferId: id, by });
      return u;
    }
    await tx.settlementTransfer.update({ where: { id }, data: { status: 'SETTLED', settledAt: new Date(), failureReason: null, finality: 'OPERATOR_ATTESTED' } });
    if (t.counterparty.kind === 'NETWORK') {
      const rw = t.receivingWalletId ? await tx.wallet.findUnique({ where: { id: t.receivingWalletId }, include: { institution: { select: { status: true } } } }) : null;
      if (!rw || rw.institution.status !== 'ACTIVE') throw new ApiError('PARTICIPANT_NOT_READY', 'receiving wallet is missing or its institution is not active; cannot credit', 409);
      await creditReceiver(tx, t, rw, 'OPERATOR_ATTESTED');
    }
    const u = (await tx.settlementTransfer.findUnique({ where: { id } }))!;
    await emit({ ...u, counterparty: t.counterparty }, 'transfer.settled', { finality: 'OPERATOR_ATTESTED', slot: null, evidence: evidence.slice(0, 300), counterpartyAddress: t.counterparty.kind === 'NETWORK' ? null : t.counterparty.address, participant: t.counterparty.kind === 'NETWORK' ? t.counterparty.address.replace(/^network:/, '') : null }, tx);
    await resolveOpenException('TRANSFER_ATTENTION', id, t.assetId, by, `decided SETTLED: ${evidence}`, tx);
    log.warn('transfer.review_settled', { transferId: id, by });
    return u;
  });
}

// ── Finality (sweeper) ────────────────────────────────────────────────────────
export async function finalizeConfirmedTransfers(limit = 50): Promise<{ settled: number; pending: number; attention: number }> {
  const rows = await prisma.settlementTransfer.findMany({ where: { status: 'CONFIRMED' }, include: { counterparty: true }, take: limit, orderBy: { confirmedAt: 'asc' } });
  const out = { settled: 0, pending: 0, attention: 0 };
  for (const t of rows) {
    const asset = getAsset(t.assetId);
    try {
      let finality: 'ON_CHAIN_FINALIZED' | 'SANDBOX_SIMULATED'; let slot: string | null = null;
      const receiving = t.receivingWalletId ? await prisma.wallet.findUnique({ where: { id: t.receivingWalletId }, include: { institution: { select: { status: true } } } }) : null;
      if (t.counterparty.kind === 'NETWORK' && (!receiving || !receiving.depositAddress || receiving.institution.status !== 'ACTIVE')) {
        // Funds are in a vault we cannot attribute: never mark SETTLED without the credit. A person decides.
        await moveToReview(t, `receiving wallet ${t.receivingWalletId ?? '(none)'} is ${receiving ? (receiving.depositAddress ? `on a ${receiving.institution.status} institution` : 'missing its deposit address') : 'missing'}; credit not posted`);
        out.attention++; continue;
      }
      const recipient = t.counterparty.kind === 'NETWORK' ? receiving!.depositAddress! : t.counterparty.address;
      if (t.txHash) {
        const r = await proveSettlement({ entityType: 'SettlementTransfer', entityId: t.id, signature: t.txHash, asset: asset.id, expectedAmount: t.amount, toAddress: recipient, requireRecipient: true });
        if (r.status === 'PENDING_BROADCAST') { out.pending++; continue; }
        finality = 'ON_CHAIN_FINALIZED'; slot = r.proof?.slot?.toString() ?? null;
      } else if (!providers.custody().configured()) {
        finality = 'SANDBOX_SIMULATED'; // the stub custodian has no chain; say so rather than pretend
      } else { out.pending++; continue; } // real custody said completed but no hash yet — wait for the webhook/poll
      await prisma.$transaction(async tx => {
        const c = await tx.settlementTransfer.updateMany({ where: { id: t.id, status: 'CONFIRMED' }, data: { status: 'SETTLED', settledAt: new Date(), failureReason: null, finality } });
        if (c.count !== 1) return;
        if (t.counterparty.kind === 'NETWORK') {
          // Re-read under the transaction: the wallet must still be the one fixed at approval, on an active institution.
          const rw = await tx.wallet.findUnique({ where: { id: t.receivingWalletId! }, include: { institution: { select: { status: true } } } });
          if (!rw || rw.institutionId !== receiving!.institutionId || rw.institution.status !== 'ACTIVE') throw Object.assign(new Error('receiving wallet changed during finality; settlement rolled back for review'), { code: 'RECEIVER_CHANGED', retryable: false });
          const receivingW = rw;
          // Credit the receiving participant now: custody + / its liability −, same entity, its own posting key.
          // The custody-deposit path refuses vault-sourced receipts, so this is the only credit for a network move.
          await creditReceiver(tx, t, receivingW, finality);
        }
        await emit({ ...t, status: 'SETTLED' }, 'transfer.settled', { finality, slot, counterpartyAddress: t.counterparty.kind === 'NETWORK' ? null : t.counterparty.address, participant: t.counterparty.kind === 'NETWORK' ? t.counterparty.address.replace(/^network:/, '') : null }, tx);
      });
      out.settled++;
    } catch (e) {
      const err = e as Error & { code?: string; retryable?: boolean };
      if (err.retryable || err.code === 'PROOF_UNAVAILABLE') { out.pending++; continue; }
      if (e instanceof ProofMismatchError || e instanceof SettlementNotFinalError) {
        // Custody says it completed; the chain disagrees. Money may have left: never auto-reverse. A human decides.
        out.attention++;
        await moveToReview(t, `on-chain proof failed: ${err.message}`);
        continue;
      }
      if (err.code === 'RECEIVER_CHANGED') { out.attention++; await moveToReview(t, err.message); continue; }
      out.pending++; log.warn('transfer.proof_error', { transferId: t.id, message: err.message });
    }
  }
  if (out.settled || out.attention) log.info('transfer.finalized', out);
  return out;
}

let sweeper: ReturnType<typeof setInterval> | null = null;
export function startTransferSweeper(intervalMs = 15_000): void {
  if (sweeper) return;
  sweeper = setInterval(() => { runTransferSweep().catch(e => log.error('transfer.sweep_failed', { message: (e as Error).message })); }, intervalMs);
  sweeper.unref?.();
}
export function stopTransferSweeper(): void { if (sweeper) { clearInterval(sweeper); sweeper = null; } }
export async function runTransferSweep() {
  if (sweeping) return; sweeping = true;
  try { await submitApprovedTransfers(); await pollSubmittedTransfers(); await finalizeConfirmedTransfers(); } finally { sweeping = false; }
}

// ── Serialisation ─────────────────────────────────────────────────────────────
export function publicStatus(t: SettlementTransfer): 'PROCESSING' | 'COMPLETED' | 'FAILED' {
  if (t.status === 'SETTLED') return 'COMPLETED';
  if (['FAILED', 'REJECTED', 'CANCELLED'].includes(t.status)) return 'FAILED';
  return 'PROCESSING';
}
export async function serializeTransfer(t: SettlementTransfer & { counterparty?: Counterparty }) {
  const proofs = t.txHash ? await proofsFor('SettlementTransfer', t.id) : [];
  const proven = proofs.find(p => !p.onchainError);
  return {
    id: t.id, kind: 'TRANSFER', status: publicStatus(t), stage: t.status,
    walletId: t.walletId, counterparty: t.counterparty ? { id: t.counterparty.id, label: t.counterparty.label, address: t.counterparty.address, network: t.counterparty.network } : { id: t.counterpartyId },
    asset: t.assetId, amount: t.amount.toFixed(), reference: t.reference, idempotencyKey: t.idempotencyKey,
    approval: t.status === 'AWAITING_APPROVAL' ? { required: true, by: 'operator' } : t.approvedAt ? { required: false, by: t.approvedBy, at: t.approvedAt } : null,
    proof: t.providerTxId || t.txHash ? { custodyTxId: t.providerTxId, txHash: t.txHash, explorerUrl: t.txHash ? `https://solscan.io/tx/${t.txHash}` : null,
      finality: t.status === 'SETTLED' ? (t.finality ?? (proven ? 'ON_CHAIN_FINALIZED' : 'SANDBOX_SIMULATED')) : t.status === 'UNDER_REVIEW' ? 'UNDER_REVIEW' : t.status === 'CONFIRMED' ? 'CUSTODY_CONFIRMED' : 'PENDING', slot: proven?.slot ?? null } : null,
    ...(t.failureReason ? { attention: true, reason: t.failureReason } : {}),
    submittedAt: t.submittedAt, confirmedAt: t.confirmedAt, settledAt: t.settledAt, createdAt: t.createdAt,
  };
}
