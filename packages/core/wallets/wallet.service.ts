/**
 * Wallets (Step 2, slice 1).
 *
 * A wallet is an institution's custody vault on one network, bound to one API environment.
 * It is the unit of ownership for balances and transactions: every custody receipt is attributed
 * to a wallet (and through it to an institution), never to a loose vault id.
 *
 * Custody is reached through a small interface registered at boot (`setWalletCustody`), so this
 * package never imports a provider. With nothing registered, a sandbox stub issues deterministic
 * vault ids and addresses — refused in production.
 */
import { Prisma, type Wallet, type WalletBalance } from '@prisma/client';
import { prisma } from '../ledger/ledger.service';
import { ACTIVE_NETWORK, ASSETS, NETWORKS, type AssetDefinition, type NetworkId } from '../assets/registry';
import { ApiError } from '../../shared/errors';
import { log } from '../../shared/logger';
import { AccountCode } from '../ledger/accounts';
import { providers } from '../../providers/registry/provider-registry';
import type { CustodyProvider } from '../../providers/ports';

/**
 * Custody is reached through the provider registry (`providers.custody()`), never a vendor module.
 * `custodyEnvironmentKind()` decides which API environment this deployment's custody can serve.
 */
export function custodyEnvironmentKind(): 'SANDBOX' | 'PRODUCTION' {
  return providers.custody().configured() && process.env.FIREBLOCKS_SANDBOX !== 'true' ? 'PRODUCTION' : 'SANDBOX';
}

function activeCustody(environmentKind: 'SANDBOX' | 'PRODUCTION'): CustodyProvider {
  const c = providers.custody();
  if (environmentKind === 'PRODUCTION' && custodyEnvironmentKind() !== 'PRODUCTION') {
    throw new ApiError('CUSTODY_NOT_CONFIGURED', 'production wallets need real custody credentials on the production workspace; refusing to persist a sandbox vault as production', 503);
  }
  if (environmentKind === 'SANDBOX' && custodyEnvironmentKind() === 'PRODUCTION') {
    throw new ApiError('CUSTODY_ENVIRONMENT_MISMATCH', 'this deployment is bound to production custody; sandbox wallets are created on a sandbox deployment', 409);
  }
  return c;
}

export const MAX_WALLETS_PER_ENVIRONMENT = Number(process.env.MAX_WALLETS_PER_ENVIRONMENT ?? 20);

export interface CreateWalletInput {
  institutionId: string;
  environmentKind: 'SANDBOX' | 'PRODUCTION';
  label: string;
  network?: NetworkId;
}

export async function createWallet(input: CreateWalletInput): Promise<Wallet & { balances: WalletBalance[] }> {
  const network = input.network ?? ACTIVE_NETWORK;
  if (!NETWORKS[network]) throw new ApiError('UNSUPPORTED_NETWORK', `network ${network} is not supported`, 400);
  const env = await prisma.apiEnvironment.findUnique({ where: { institutionId_kind: { institutionId: input.institutionId, kind: input.environmentKind } }, include: { institution: { select: { status: true } } } });
  if (!env) throw new ApiError('NOT_FOUND', 'environment not found', 404);
  if (env.institution.status !== 'ACTIVE') throw new ApiError('INSTITUTION_INACTIVE', `institution is ${env.institution.status}`, 409);
  if (env.status !== 'ACTIVE') throw new ApiError('ENVIRONMENT_DISABLED', `${input.environmentKind} environment is ${env.status}`, 409);
  // A label is unique per environment so a retried request finds the wallet instead of minting a second vault.
  // Enforced by @@unique([environmentId, label]) as well: two concurrent creates cannot both persist.
  const dup = await prisma.wallet.findFirst({ where: { environmentId: env.id, label: input.label } });
  if (dup) throw new ApiError('WALLET_EXISTS', `a wallet labelled '${input.label}' already exists in ${input.environmentKind}`, 409, { walletId: dup.id });
  const count = await prisma.wallet.count({ where: { environmentId: env.id } });
  if (count >= MAX_WALLETS_PER_ENVIRONMENT) throw new ApiError('WALLET_LIMIT', `an environment may hold at most ${MAX_WALLETS_PER_ENVIRONMENT} wallets; ask operations to raise the limit`, 409);

  const c = activeCustody(input.environmentKind);
  const clientRef = `${input.institutionId}:${env.kind}:${input.label}`; // stable: same request → same vault name at the custodian
  const { vaultId } = await c.createVault(`${input.institutionId}/${input.environmentKind}/${input.label}`, clientRef);
  // One address serves every supported asset on the network (Solana: USDC and USDT share it).
  // A custodian answering two different addresses means we do not understand the vault: refuse,
  // because the one we would have stored would silently misdirect the other asset.
  const assets = Object.values(ASSETS).filter(a => a.network === network);
  let address: string | null = null;
  for (const a of assets) {
    const r = await c.getDepositAddress(vaultId, { symbol: a.symbol, chain: a.network });
    if (address && r.address !== address) {
      log.error('wallet.address_mismatch', { vaultId, asset: a.id, address: r.address, expected: address });
      throw new ApiError('CUSTODY_ADDRESS_MISMATCH', `custodian issued different deposit addresses for ${assets[0].id} and ${a.id} in vault ${vaultId}; wallet not created`, 502);
    }
    address ??= r.address;
  }

  let wallet;
  try {
    wallet = await prisma.wallet.create({
      data: {
        institutionId: input.institutionId, environmentId: env.id, label: input.label,
        custodyProvider: c.id, custodyVaultId: vaultId, network, depositAddress: address,
        balances: { create: assets.map(a => ({ assetId: a.id })) },
      },
      include: { balances: true },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      // Lost the race with a concurrent create of the same label: the vault we just asked for is
      // orphaned at the custodian (logged for operations), and the caller gets the wallet that won.
      const won = await prisma.wallet.findFirst({ where: { environmentId: env.id, label: input.label } });
      log.warn('wallet.create_race', { institutionId: input.institutionId, environmentId: env.id, label: input.label, orphanVaultId: vaultId, walletId: won?.id });
      throw new ApiError('WALLET_EXISTS', `a wallet labelled '${input.label}' already exists in ${input.environmentKind}`, 409, { walletId: won?.id });
    }
    throw e;
  }
  log.info('wallet.created', { institutionId: input.institutionId, environmentId: env.id, walletId: wallet.id, network, custodyConfigured: c.configured() });
  return wallet;
}

/** Wallets visible to one credential: its institution AND its environment, nothing else. */
export function listWallets(institutionId: string, environmentId: string) {
  return prisma.wallet.findMany({ where: { institutionId, environmentId }, include: { balances: true }, orderBy: { createdAt: 'asc' } });
}

/** Operator view: every wallet of an institution across environments. */
export function listInstitutionWallets(institutionId: string) {
  return prisma.wallet.findMany({ where: { institutionId }, include: { balances: true, environment: { select: { kind: true } } }, orderBy: { createdAt: 'asc' } });
}

export async function getWallet(id: string, scope: { institutionId: string; environmentId?: string }) {
  const w = await prisma.wallet.findFirst({ where: { id, institutionId: scope.institutionId, ...(scope.environmentId ? { environmentId: scope.environmentId } : {}) }, include: { balances: true } });
  if (!w) throw new ApiError('NOT_FOUND', 'wallet not found', 404); // never reveals another tenant's wallet
  return w;
}

/** Resolve the wallet that owns a custody vault (used by the deposit path). */
export function walletForVault(tx: Prisma.TransactionClient, provider: string, custodyVaultId: string) {
  return tx.wallet.findUnique({ where: { custodyProvider_custodyVaultId: { custodyProvider: provider, custodyVaultId } }, include: { environment: { select: { kind: true } } } });
}

/**
 * Authoritative balance of one wallet asset: the journal's CUSTODY:<vault>:<ASSET> account
 * (debit-normal: deposits increase it, settlements out decrease it). `WalletBalance` is only a
 * projection of this and is reconciled against it.
 */
export async function journalBalance(walletOrVault: { custodyVaultId: string }, assetId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Prisma.Decimal> {
  const code = AccountCode.custody(walletOrVault.custodyVaultId, assetId);
  const ledger = await db.ledgerAccount.findUnique({ where: { code }, select: { id: true } });
  if (!ledger) return new Prisma.Decimal(0);
  const sum = (await db.journalLine.aggregate({ where: { accountId: ledger.id }, _sum: { amount: true } }))._sum.amount;
  return sum ?? new Prisma.Decimal(0);
}

/** Balances as the API serves them: journal-derived, with the projection beside it for drift visibility. */
export async function walletBalances(w: Wallet & { balances: WalletBalance[] }) {
  return Promise.all(w.balances.map(async b => {
    const available = await journalBalance(w, b.assetId);
    return { asset: b.assetId, available: available.toFixed(), pending: b.pending.toFixed(), projected: b.available.toFixed(), drift: !available.equals(b.available), updatedAt: b.updatedAt };
  }));
}

/** Move the projection with the journal. Must run inside the same transaction as the posting. */
export async function applyWalletCredit(tx: Prisma.TransactionClient, walletId: string, assetId: string, amount: Prisma.Decimal) {
  await tx.walletBalance.upsert({
    where: { walletId_assetId: { walletId, assetId } },
    update: { available: { increment: amount } },
    create: { walletId, assetId, available: amount },
  });
}

export async function serializeWallet(w: Wallet & { balances: WalletBalance[]; environment?: { kind: string } }) {
  return {
    id: w.id, label: w.label, status: w.status, network: w.network,
    custody: { provider: w.custodyProvider, vaultId: w.custodyVaultId },
    depositAddress: w.depositAddress,
    ...(w.environment ? { environment: w.environment.kind } : {}),
    balances: await walletBalances(w),
    createdAt: w.createdAt,
  };
}
