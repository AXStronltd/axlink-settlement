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
import { randomBytes } from 'crypto';
import { prisma } from '../ledger/ledger.service';
import { ASSETS, NETWORKS, type AssetDefinition, type NetworkId } from '../assets/registry';
import { ApiError } from '../../shared/errors';
import { log } from '../../shared/logger';

export interface WalletCustody {
  readonly provider: 'fireblocks';
  /** Create a custody vault for the institution. `clientRef` is our idempotency handle. */
  createVault(label: string, clientRef: string): Promise<{ vaultId: string }>;
  /** Issue (or return the existing) deposit address for one asset in the vault. */
  createDepositAddress(vaultId: string, asset: AssetDefinition): Promise<{ address: string; tag?: string }>;
  /** True when real provider credentials are configured. */
  configured(): boolean;
}

let custody: WalletCustody | null = null;
export function setWalletCustody(c: WalletCustody | null): void { custody = c; }

const sandboxStub: WalletCustody = {
  provider: 'fireblocks',
  configured: () => false,
  async createVault(_label, clientRef) { return { vaultId: `vault_sbx_${clientRef.slice(0, 12)}_${randomBytes(6).toString('hex')}` }; },
  async createDepositAddress(vaultId, asset) { return { address: `sbx_${asset.network}_${vaultId}`.slice(0, 44) }; },
};

function activeCustody(): WalletCustody {
  const c = custody ?? sandboxStub;
  if (!c.configured() && process.env.NODE_ENV === 'production') {
    throw new ApiError('CUSTODY_NOT_CONFIGURED', 'custody provider is not configured; refusing to create a wallet in production', 503);
  }
  return c;
}

export interface CreateWalletInput {
  institutionId: string;
  environmentKind: 'SANDBOX' | 'PRODUCTION';
  label: string;
  network?: NetworkId;
}

export async function createWallet(input: CreateWalletInput): Promise<Wallet & { balances: WalletBalance[] }> {
  const network = input.network ?? 'solana-mainnet';
  if (!NETWORKS[network]) throw new ApiError('UNSUPPORTED_NETWORK', `network ${network} is not supported`, 400);
  const env = await prisma.apiEnvironment.findUnique({ where: { institutionId_kind: { institutionId: input.institutionId, kind: input.environmentKind } } });
  if (!env) throw new ApiError('NOT_FOUND', 'environment not found', 404);
  if (env.status !== 'ACTIVE') throw new ApiError('ENVIRONMENT_DISABLED', `${input.environmentKind} environment is ${env.status}`, 409);

  const c = activeCustody();
  const clientRef = `${input.institutionId}:${env.id}:${Date.now().toString(36)}`;
  const { vaultId } = await c.createVault(`${input.institutionId}/${input.environmentKind}/${input.label}`, clientRef);
  // One address serves every supported asset on the network (Solana: USDC and USDT share it).
  const assets = Object.values(ASSETS).filter(a => a.network === network);
  let address: string | null = null;
  for (const a of assets) {
    const r = await c.createDepositAddress(vaultId, a);
    if (address && r.address !== address) {
      log.warn('wallet.address_mismatch', { vaultId, asset: a.id, address: r.address, expected: address });
    }
    address ??= r.address;
  }

  const wallet = await prisma.wallet.create({
    data: {
      institutionId: input.institutionId, environmentId: env.id, label: input.label,
      custodyProvider: c.provider, custodyVaultId: vaultId, network, depositAddress: address,
      balances: { create: assets.map(a => ({ assetId: a.id })) },
    },
    include: { balances: true },
  });
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
  return tx.wallet.findUnique({ where: { custodyProvider_custodyVaultId: { custodyProvider: provider, custodyVaultId } } });
}

/** Move the projection with the journal. Must run inside the same transaction as the posting. */
export async function applyWalletCredit(tx: Prisma.TransactionClient, walletId: string, assetId: string, amount: Prisma.Decimal) {
  await tx.walletBalance.upsert({
    where: { walletId_assetId: { walletId, assetId } },
    update: { available: { increment: amount } },
    create: { walletId, assetId, available: amount },
  });
}

export function serializeWallet(w: Wallet & { balances: WalletBalance[]; environment?: { kind: string } }) {
  return {
    id: w.id, label: w.label, status: w.status, network: w.network,
    custody: { provider: w.custodyProvider, vaultId: w.custodyVaultId },
    depositAddress: w.depositAddress,
    ...(w.environment ? { environment: w.environment.kind } : {}),
    balances: w.balances.map(b => ({ asset: b.assetId, available: b.available.toString(), pending: b.pending.toString(), updatedAt: b.updatedAt })),
    createdAt: w.createdAt,
  };
}
