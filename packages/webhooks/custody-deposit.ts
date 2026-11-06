/**
 * Atomic, asset-denominated custody receipt (F1/F3/F5).
 * Caller authenticates original bytes and binds the signed Fireblocks workspace.
 * Here an explicit instruction, pending status, destination vault, supported asset
 * and exact NET received units must agree. Internal wallet moves cannot create
 * new deposit liabilities. Claim, canonical-asset balance, balanced journal and
 * status all commit or roll back inside the provider-event transaction.
 * This is custody-provider evidence, not independent on-chain finality verification.
 */
import { Prisma } from '@prisma/client';
import { credit } from '../core/ledger/ledger.service';
import { resolveProviderAsset, toMinorUnits, type AssetDefinition } from '../core/assets/registry';
import { post } from '../core/ledger/journal.service';
import { AccountCode } from '../core/ledger/accounts';
import { EventIgnored, onEventIgnored, type EventOutcome, type Tx } from './provider-event.service';
import { walletForVault, applyWalletCredit, custodyEnvironmentKind } from '../core/wallets/wallet.service';
import { emitInstitutionEvent } from '../core/webhooks/webhook-endpoint.service';

export interface CustodyCompletion {
  provider: 'fireblocks';
  providerAssetId?: string;
  destinationVaultId?: string;
  externalTxId?: string;
  providerTxId?: string;
  amount?: number | string;
  operation?: string;
  destinationType?: string;
  sourceType?: string;
  sourceVaultId?: string;
  network?: string;
  contract?: string;
  txHash?: string;
}

export class DepositAlreadySettled extends Error {
  constructor(public readonly outcome: EventOutcome) { super(outcome.reason ?? 'already settled'); }
}

export async function applyCustodyDeposit(tx: Tx, ev: CustodyCompletion): Promise<{ outcome: EventOutcome; result: { credited: Prisma.Decimal; currency: string; asset: AssetDefinition } }> {
  const asset = resolveProviderAsset(ev.provider, ev.providerAssetId);
  if (!asset) {
    throw new EventIgnored({ status: 'IGNORED', reason: `unsupported asset or network: ${ev.providerAssetId ?? '(none)'}`, vaultId: ev.destinationVaultId ?? null });
  }
  if (!ev.destinationVaultId) {
    throw new EventIgnored({ status: 'IGNORED', reason: 'no destination vault', assetId: asset.id });
  }

  // ── Step 2 path: a deposit INSTRUCTION on a wallet (no legacy user row) ─────────────────────
  if ((ev.externalTxId ?? '').startsWith('dep_')) {
    const instr = await tx.depositInstruction.findUnique({ where: { trackingId: ev.externalTxId! }, include: { wallet: { include: { environment: { select: { kind: true } } } } } });
    if (instr) return settleInstruction(tx, ev, asset, instr);
  }

  const user = await tx.user.findUnique({ where: { vaultId: ev.destinationVaultId }, select: { id: true, institutionId: true, vaultId: true } });
  if (!user) {
    throw new EventIgnored({ status: 'IGNORED', reason: 'destination vault is not an AxLink wallet', assetId: asset.id, vaultId: ev.destinationVaultId });
  }

  // Step 2: the vault belongs to a Wallet. When one exists it is the owner of record and must agree
  // with the legacy user's institution; a mismatch is a data error, never a credit.
  const wallet = await walletForVault(tx, ev.provider, ev.destinationVaultId);
  const attribution = { assetId: asset.id, institutionId: wallet?.institutionId ?? user.institutionId, vaultId: user.vaultId, walletId: wallet?.id ?? null };
  if (wallet && user.institutionId && wallet.institutionId !== user.institutionId) {
    throw new EventIgnored({ status: 'REJECTED', reason: 'wallet and legacy user disagree on owning institution', ...attribution });
  }
  if (wallet && wallet.environment.kind !== custodyEnvironmentKind()) {
    // A production-workspace receipt into a sandbox wallet (or the reverse) is a configuration error,
    // not a deposit. Rejected and recorded; the funds stay in the vault for operator action.
    throw new EventIgnored({ status: 'REJECTED', reason: `custody is ${custodyEnvironmentKind()} but wallet is ${wallet.environment.kind}`, ...attribution });
  }
  if (wallet && wallet.status === 'CLOSED') {
    throw new EventIgnored({ status: 'REJECTED', reason: 'wallet is CLOSED', ...attribution });
  }
  if (wallet && wallet.status === 'SUSPENDED') {
    // Transient: throw a plain error so the transaction rolls back WITHOUT recording the event —
    // the provider's retry settles it once the wallet is active again.
    throw Object.assign(new Error(`wallet ${wallet.id} is SUSPENDED; receipt deferred`), { code: 'WALLET_SUSPENDED', retryable: true });
  }
  if (wallet && wallet.network !== asset.network) {
    throw new EventIgnored({ status: 'REJECTED', reason: 'asset network differs from wallet network', ...attribution });
  }
  const reject = (reason: string): never => { throw new EventIgnored({ status: 'REJECTED', reason, ...attribution }); };
  if (ev.operation !== 'TRANSFER' || ev.destinationType !== 'VAULT_ACCOUNT') reject('only custody transfer receipts can settle deposits');
  if (ev.sourceType === 'VAULT_ACCOUNT' || (ev.sourceVaultId && await tx.user.findUnique({ where: { vaultId: ev.sourceVaultId }, select: { id: true } }))) {
    reject('internal wallet movements must not create a fresh deposit liability');
  }
  if ((ev.network !== undefined && ev.network !== asset.network) || (ev.contract !== undefined && ev.contract !== asset.contract)) {
    reject('network or token contract conflicts with signed provider asset identity');
  }
  const trackingId = ev.externalTxId ?? '';
  if (!trackingId.startsWith('dep_')) reject('explicit deposit tracking id required');
  const deposit = await tx.bankDeposit.findUnique({ where: { trackingId } });
  if (!deposit) reject('unknown deposit tracking id');
  // Prisma's nullable return is narrowed explicitly after the rejecting branch.
  if (!deposit) throw new Error('unreachable');
  if (deposit.userId !== user.id) reject('deposit does not belong to destination wallet');
  if (deposit.status !== 'PENDING_FIREBLOCKS') {
    throw new EventIgnored({ status: 'IGNORED', reason: 'deposit not awaiting custody', ...attribution, entityType: 'BankDeposit', entityId: deposit.id });
  }
  if (deposit.fbTxId && deposit.fbTxId !== ev.providerTxId) reject('custody transaction differs from expected transaction');
  if ((deposit.currency !== asset.symbol && deposit.currency !== asset.id) ||
      (deposit.settlementAssetId !== null && deposit.settlementAssetId !== asset.id)) {
    reject('deposit expected asset differs from received asset; fiat orders cannot settle here');
  }
  // No conversion or inferred fee tolerance in this security fix: credit only exact,
  // positive token units matching the pending asset-denominated instruction.
  let amount: Prisma.Decimal;
  try {
    if (ev.amount === undefined) reject('missing received amount');
    amount = new Prisma.Decimal(ev.amount!);
    if (!amount.isFinite() || !amount.isPositive() || amount.isZero()) reject('invalid received amount');
    toMinorUnits(amount, asset);
    toMinorUnits(deposit.amount, asset);
  } catch { reject('invalid received amount or unsupported asset precision'); }
  if (!amount!.eq(deposit.amount)) reject('received amount does not match pending deposit');

  // Lock/claim the pending domain row before touching balances. Different provider
  // event IDs for the same deposit serialize here and only one can claim it.
  const settled = await tx.bankDeposit.updateMany({
    where: { id: deposit.id, status: 'PENDING_FIREBLOCKS', currency: deposit.currency,
      amount: deposit.amount, settlementAssetId: deposit.settlementAssetId },
    data: { status: 'COMPLETED', fbTxId: ev.providerTxId ?? null, settlementAssetId: asset.id },
  });
  if (settled.count !== 1) {
    throw new EventIgnored({ status: 'IGNORED', reason: 'deposit already settled or instruction changed', ...attribution, entityType: 'BankDeposit', entityId: deposit.id });
  }
  const journal = await post(tx, {
    eventType: 'DEPOSIT', entityType: 'BankDeposit', entityId: deposit.id,
    postingKey: `BankDeposit:${deposit.id}:custody:${asset.id}`,
    narrative: `Custody receipt ${asset.id} on ${asset.network} for institution ${user.institutionId ?? 'legacy-operator'}`,
    lines: [
      { account: AccountCode.custody(user.vaultId, asset.id), currency: asset.id, amount: amount!, usdAmount: amount! },
      { account: AccountCode.user(user.id, asset.id), userId: user.id, currency: asset.id, amount: amount!.negated(), usdAmount: amount!.negated() },
    ],
  });
  if (!journal.created) reject('deposit journal already exists; operator reconciliation required');
  await credit(tx, user.id, asset.id, amount!);
  if (wallet) await applyWalletCredit(tx, wallet.id, asset.id, amount!);

  return {
    outcome: { status: 'PROCESSED', ...attribution, entityType: 'BankDeposit', entityId: deposit.id },
    result: { credited: amount!, currency: asset.id, asset },
  };
}

// ── Instruction settlement (Step 2, slice 2) ─────────────────────────────────────────────────
type InstrRow = Prisma.DepositInstructionGetPayload<{ include: { wallet: { include: { environment: { select: { kind: true } } } } } }>;

async function settleInstruction(tx: Tx, ev: CustodyCompletion, asset: AssetDefinition, instr: InstrRow): Promise<{ outcome: EventOutcome; result: { credited: Prisma.Decimal; currency: string; asset: AssetDefinition } }> {
  const w = instr.wallet;
  const attribution = { assetId: asset.id, institutionId: instr.institutionId, vaultId: w.custodyVaultId, walletId: w.id, entityType: 'DepositInstruction', entityId: instr.id };
  const reject = (reason: string): never => { throw new EventIgnored({ status: 'REJECTED', reason, ...attribution }); };
  // Same evidence rules as the legacy path (Step 1 F3): transfer into a vault, not an internal move,
  // network/contract consistent with the signed asset, exact net amount.
  if (ev.operation !== 'TRANSFER' || ev.destinationType !== 'VAULT_ACCOUNT') reject('only custody transfer receipts can settle deposits');
  if (ev.sourceType === 'VAULT_ACCOUNT' || (ev.sourceVaultId && (
      await tx.wallet.findUnique({ where: { custodyProvider_custodyVaultId: { custodyProvider: ev.provider, custodyVaultId: ev.sourceVaultId } }, select: { id: true } }) ||
      await tx.user.findUnique({ where: { vaultId: ev.sourceVaultId }, select: { id: true } })))) {
    reject('internal wallet movements must not create a fresh deposit liability');
  }
  if ((ev.network !== undefined && ev.network !== asset.network) || (ev.contract !== undefined && ev.contract !== asset.contract)) reject('network or token contract conflicts with signed provider asset identity');
  if (ev.destinationVaultId !== w.custodyVaultId) reject('receipt landed in a different vault than the instruction\'s wallet');
  if (w.environment.kind !== custodyEnvironmentKind()) reject(`custody is ${custodyEnvironmentKind()} but wallet is ${w.environment.kind}`);
  if (w.status === 'CLOSED') reject('wallet is CLOSED');
  if (w.status === 'SUSPENDED') throw Object.assign(new Error(`wallet ${w.id} is SUSPENDED; receipt deferred`), { code: 'WALLET_SUSPENDED', retryable: true });
  if (instr.assetId !== asset.id) reject(`instruction expects ${instr.assetId}, received ${asset.id}`);
  if (instr.status !== 'PENDING') throw new EventIgnored({ status: 'IGNORED', reason: `instruction is ${instr.status}`, ...attribution });
  if (instr.expiresAt <= new Date()) reject('instruction expired before the receipt; operator review for the funds in custody');
  let amount: Prisma.Decimal;
  try {
    if (ev.amount === undefined) reject('missing received amount');
    amount = new Prisma.Decimal(ev.amount!);
    if (!amount.isFinite() || !amount.isPositive() || amount.isZero()) reject('invalid received amount');
    toMinorUnits(amount, asset);
  } catch { reject('invalid received amount or unsupported asset precision'); }
  if (!amount!.eq(instr.expectedAmount)) reject(`received ${amount!.toFixed()} differs from instructed ${instr.expectedAmount.toFixed()}`);

  // Claim first: only one event can flip PENDING → SETTLED; the rest see IGNORED above on retry.
  const claimed = await tx.depositInstruction.updateMany({
    where: { id: instr.id, status: 'PENDING', expectedAmount: instr.expectedAmount, assetId: instr.assetId },
    data: { status: 'RECEIVED', providerTxId: ev.providerTxId ?? null, txHash: ev.txHash ?? null, receivedAmount: amount!, receivedAt: new Date(), lastReceiptError: null },
  });
  if (claimed.count !== 1) {
    // Lost the race: re-read so the reason is true (an expiry sweep or a concurrent receipt got there first).
    const now = await tx.depositInstruction.findUnique({ where: { id: instr.id }, select: { status: true } });
    if (now?.status === 'EXPIRED' || now?.status === 'CANCELLED') reject(`instruction became ${now.status} before the receipt was recorded; funds are in custody — operator review`);
    throw new EventIgnored({ status: 'IGNORED', reason: `instruction already ${now?.status ?? 'changed'}`, ...attribution });
  }

  const journal = await post(tx, {
    eventType: 'DEPOSIT', entityType: 'DepositInstruction', entityId: instr.id,
    postingKey: `DepositInstruction:${instr.id}:custody:${asset.id}`,
    narrative: `Custody receipt ${asset.id} on ${asset.network} for institution ${instr.institutionId} (wallet ${w.id})`,
    lines: [
      { account: AccountCode.custody(w.custodyVaultId, asset.id), currency: asset.id, amount: amount!, usdAmount: amount! },
      { account: AccountCode.institution(instr.institutionId, asset.id), currency: asset.id, amount: amount!.negated(), usdAmount: amount!.negated() },
    ],
  });
  if (!journal.created) reject('deposit journal already exists; operator reconciliation required');
  await applyWalletCredit(tx, w.id, asset.id, amount!);
  // Custody confirmed and the wallet is credited, but the public status stays PROCESSING until a
  // Solana node reports the signature finalized (finalizeReceivedInstructions → deposit.settled).
  await emitInstitutionEvent(tx, { institutionId: instr.institutionId, environmentId: instr.environmentId }, 'deposit.received', {
    settlementId: instr.id, kind: 'DEPOSIT', status: 'PROCESSING', finality: 'CUSTODY_CONFIRMED', walletId: w.id, asset: asset.id, amount: amount!.toFixed(),
    reference: instr.reference, trackingId: instr.trackingId, custodyTxId: ev.providerTxId ?? null, txHash: ev.txHash ?? null,
  }, { entityType: 'DepositInstruction', entityId: instr.id });

  return { outcome: { status: 'PROCESSED', ...attribution }, result: { credited: amount!, currency: asset.id, asset } };
}

// A rejected receipt for an instruction is something the institution must see: money arrived and
// was not credited. Recorded on the instruction and announced, outside the rolled-back transaction.
onEventIgnored(async (_event, outcome) => {
  if (outcome.entityType !== 'DepositInstruction' || !outcome.entityId || outcome.status !== 'REJECTED') return;
  const { prisma } = await import('../core/ledger/ledger.service');
  await prisma.$transaction(async (tx) => {
    const i = await tx.depositInstruction.update({ where: { id: outcome.entityId! }, data: { lastReceiptError: outcome.reason ?? 'rejected', lastReceiptAt: new Date() } });
    await emitInstitutionEvent(tx, { institutionId: i.institutionId, environmentId: i.environmentId }, 'deposit.rejected',
      { settlementId: i.id, kind: 'DEPOSIT', status: 'PROCESSING', attention: true, reason: outcome.reason ?? 'rejected', walletId: i.walletId, asset: i.assetId, expectedAmount: i.expectedAmount.toFixed(), reference: i.reference, trackingId: i.trackingId },
      { entityType: 'DepositInstruction', entityId: i.id });
  });
});
