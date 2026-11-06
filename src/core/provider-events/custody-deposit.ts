/**
 * Custody deposit completion (remediation F3).
 *
 * A stablecoin arrived in a custody vault. Before any ledger effect, the event must resolve to:
 *   - an ASSET from the registry (network + contract), via the provider's asset id. USDC_ETH, SOL
 *     or an unknown token resolve to nothing and the event is IGNORED — never credited;
 *   - a WALLET: the destination vault, which belongs to exactly one User;
 *   - an INSTITUTION: the user's tenant (null for legacy rows; recorded as such);
 *   - the DEPOSIT it settles, by our tracking id in `externalTxId`.
 *
 * The credit, the deposit status change and the event record are one transaction (F1). The
 * status change is a conditional `updateMany` on `status != COMPLETED`; if it matches nothing the
 * deposit was already settled by another event and the whole transaction — credit included — is
 * rolled back by throwing.
 */
import { Prisma } from '@prisma/client';
import { credit } from '../ledger.service';
import { resolveProviderAsset, type AssetDefinition } from '../assets/registry';
import { EventIgnored, type EventOutcome, type Tx } from './provider-event.service';

export interface CustodyCompletion {
  provider: 'fireblocks';
  providerAssetId?: string;
  destinationVaultId?: string;
  externalTxId?: string;
  providerTxId?: string;
  amount?: number | string;
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

  const trackingId = ev.externalTxId ?? '';
  const deposit = trackingId.startsWith('dep_')
    ? await tx.bankDeposit.findUnique({ where: { trackingId } })
    : await tx.bankDeposit.findFirst({ where: { userId: user.id, status: 'PENDING_FIREBLOCKS' }, orderBy: { createdAt: 'desc' } });
  const attribution = { assetId: asset.id, institutionId: user.institutionId, vaultId: user.vaultId };
  if (!deposit) {
    throw new EventIgnored({ status: 'IGNORED', reason: `no pending deposit for ${trackingId || 'vault'}`, ...attribution });
  }
  if (deposit.userId !== user.id) {
    // The tracking id names a deposit that belongs to a different wallet: never credit either side.
    throw new EventIgnored({ status: 'REJECTED', reason: 'deposit does not belong to destination wallet', ...attribution, entityType: 'BankDeposit', entityId: deposit.id });
  }

  // Effects — all inside the caller's transaction.
  await credit(tx, user.id, deposit.currency, deposit.amount);
  const settled = await tx.bankDeposit.updateMany({
    where: { id: deposit.id, status: { not: 'COMPLETED' } },
    data: { status: 'COMPLETED', fbTxId: ev.providerTxId ?? null, settlementAssetId: asset.id },
  });
  if (settled.count !== 1) {
    // Already settled by another event: abort, which rolls back the credit above.
    throw new EventIgnored({ status: 'IGNORED', reason: 'deposit already settled', ...attribution, entityType: 'BankDeposit', entityId: deposit.id });
  }

  return {
    outcome: { status: 'PROCESSED', ...attribution, entityType: 'BankDeposit', entityId: deposit.id },
    result: { credited: deposit.amount, currency: deposit.currency, asset },
  };
}
