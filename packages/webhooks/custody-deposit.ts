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
import { EventIgnored, type EventOutcome, type Tx } from './provider-event.service';
import { walletForVault, applyWalletCredit } from '../core/wallets/wallet.service';

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
  if (wallet && wallet.status !== 'ACTIVE') {
    throw new EventIgnored({ status: 'REJECTED', reason: `wallet is ${wallet.status}`, ...attribution });
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
