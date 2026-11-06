/**
 * Deposit instructions (Step 2, slice 2).
 *
 * An institution tells AxLink "I am sending N of asset A to wallet W". AxLink answers with the
 * wallet's deposit address and a tracking id the sender puts in the custody transfer's external id.
 * The custody receipt is matched to the instruction by that id and must agree on asset and exact
 * amount; the instruction, not a legacy user row, is what gets settled.
 */
import { Prisma, type DepositInstruction } from '@prisma/client';
import { randomBytes } from 'crypto';
import { prisma } from '../../core/ledger/ledger.service';
import { getAsset, toMinorUnits, isAssetId } from '../../core/assets/registry';
import { getWallet } from '../../core/wallets/wallet.service';
import { proofsFor } from '../proof/proof.service';
import { ApiError } from '../../shared/errors';
import { log } from '../../shared/logger';

export const DEFAULT_TTL_HOURS = 72;

export interface CreateInstructionInput {
  institutionId: string; environmentId: string;
  walletId: string; asset: string; amount: string; reference?: string; ttlHours?: number;
}

export async function createDepositInstruction(input: CreateInstructionInput) {
  if (!isAssetId(input.asset)) throw new ApiError('UNSUPPORTED_ASSET', `asset ${input.asset} is not supported`, 400);
  const asset = getAsset(input.asset);
  const wallet = await getWallet(input.walletId, { institutionId: input.institutionId, environmentId: input.environmentId });
  if (wallet.status !== 'ACTIVE') throw new ApiError('WALLET_NOT_ACTIVE', `wallet is ${wallet.status}`, 409);
  if (wallet.network !== asset.network) throw new ApiError('ASSET_NETWORK_MISMATCH', `${asset.id} is on ${asset.network}; wallet is on ${wallet.network}`, 400);
  if (!wallet.depositAddress) throw new ApiError('NO_DEPOSIT_ADDRESS', 'wallet has no deposit address yet', 409);
  let amount: Prisma.Decimal;
  try { amount = new Prisma.Decimal(input.amount); toMinorUnits(amount, asset); } catch { throw new ApiError('INVALID_AMOUNT', `amount must be a decimal with at most ${asset.decimals} places`, 400); }
  if (!amount.isPositive() || amount.isZero()) throw new ApiError('INVALID_AMOUNT', 'amount must be positive', 400);
  const ttl = Math.min(Math.max(input.ttlHours ?? DEFAULT_TTL_HOURS, 1), 24 * 30);
  const instr = await prisma.depositInstruction.create({ data: {
    institutionId: input.institutionId, environmentId: input.environmentId, walletId: wallet.id, assetId: asset.id,
    expectedAmount: amount, reference: input.reference ?? null,
    trackingId: `dep_${randomBytes(12).toString('base64url')}`,
    expiresAt: new Date(Date.now() + ttl * 3600_000),
  } });
  log.info('deposit_instruction.created', { institutionId: input.institutionId, walletId: wallet.id, instructionId: instr.id, asset: asset.id });
  return { instruction: instr, depositAddress: wallet.depositAddress };
}

export async function getDepositInstruction(id: string, scope: { institutionId: string; environmentId: string }) {
  const i = await prisma.depositInstruction.findFirst({ where: { id, institutionId: scope.institutionId, environmentId: scope.environmentId }, include: { wallet: { select: { depositAddress: true, label: true } } } });
  if (!i) throw new ApiError('NOT_FOUND', 'deposit instruction not found', 404);
  return i;
}

export function listDepositInstructions(scope: { institutionId: string; environmentId: string }, status?: string) {
  return prisma.depositInstruction.findMany({ where: { institutionId: scope.institutionId, environmentId: scope.environmentId, ...(status ? { status: status as never } : {}) }, orderBy: { createdAt: 'desc' }, take: 100, include: { wallet: { select: { depositAddress: true, label: true } } } });
}

export async function cancelDepositInstruction(id: string, scope: { institutionId: string; environmentId: string }) {
  const r = await prisma.depositInstruction.updateMany({ where: { id, institutionId: scope.institutionId, environmentId: scope.environmentId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
  if (r.count !== 1) {
    const exists = await prisma.depositInstruction.findFirst({ where: { id, institutionId: scope.institutionId, environmentId: scope.environmentId } });
    if (!exists) throw new ApiError('NOT_FOUND', 'deposit instruction not found', 404);
    throw new ApiError('NOT_PENDING', `instruction is ${exists.status}; only PENDING instructions can be cancelled`, 409);
  }
}

/** The public status vocabulary the Developers page documents: PROCESSING · COMPLETED · FAILED. */
export function publicStatus(i: DepositInstruction): 'PROCESSING' | 'COMPLETED' | 'FAILED' {
  if (i.status === 'SETTLED') return 'COMPLETED';
  if (i.status === 'PENDING') return i.expiresAt > new Date() ? 'PROCESSING' : 'FAILED';
  return 'FAILED';
}

export async function serializeInstruction(i: DepositInstruction & { wallet?: { depositAddress: string | null; label: string } }, depositAddress?: string | null) {
  const proofs = i.txHash ? await proofsFor('DepositInstruction', i.id) : [];
  const explorer = i.txHash ? `https://solscan.io/tx/${i.txHash}` : null;
  return {
    id: i.id, kind: 'DEPOSIT' as const, status: publicStatus(i), instructionStatus: i.status,
    walletId: i.walletId, asset: i.assetId, expectedAmount: i.expectedAmount.toFixed(), receivedAmount: i.receivedAmount?.toFixed() ?? null,
    reference: i.reference, trackingId: i.trackingId,
    depositAddress: depositAddress ?? i.wallet?.depositAddress ?? null,
    expiresAt: i.expiresAt, settledAt: i.settledAt, createdAt: i.createdAt,
    proof: i.txHash ? {
      // Custody confirmed the receipt; on-chain finality is recorded separately when the proof service
      // has verified the signature against a Solana node. Both are stated, never conflated.
      custodyTxId: i.providerTxId, txHash: i.txHash, explorerUrl: explorer,
      finality: proofs.length && !proofs[0].onchainError ? 'ON_CHAIN_FINALIZED' : 'CUSTODY_CONFIRMED',
      onChain: proofs[0] ?? null,
    } : null,
  };
}

// ── Expiry sweep ──────────────────────────────────────────────────────────────
/** PENDING past expiresAt → EXPIRED, each with a `deposit.expired` webhook, one transaction per row. */
export async function expireDepositInstructions(now = new Date()): Promise<number> {
  const { emitInstitutionEvent } = await import('../../core/webhooks/webhook-endpoint.service');
  const due = await prisma.depositInstruction.findMany({ where: { status: 'PENDING', expiresAt: { lte: now } }, select: { id: true }, take: 200 });
  let n = 0;
  for (const { id } of due) {
    await prisma.$transaction(async tx => {
      const r = await tx.depositInstruction.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      if (r.count !== 1) return;
      const i = await tx.depositInstruction.findUniqueOrThrow({ where: { id } });
      await emitInstitutionEvent(tx, { institutionId: i.institutionId, environmentId: i.environmentId }, 'deposit.expired',
        { settlementId: i.id, kind: 'DEPOSIT', status: 'FAILED', reason: 'EXPIRED', walletId: i.walletId, asset: i.assetId, expectedAmount: i.expectedAmount.toFixed(), reference: i.reference, trackingId: i.trackingId },
        { entityType: 'DepositInstruction', entityId: i.id });
      n++;
    });
  }
  if (n) log.info('deposit_instruction.expired', { count: n });
  return n;
}

let sweeper: ReturnType<typeof setInterval> | null = null;
export function startDepositInstructionSweeper(intervalMs = 60_000): void {
  if (sweeper) return;
  sweeper = setInterval(() => { expireDepositInstructions().catch(e => log.error('deposit_instruction.sweep_failed', { message: (e as Error).message })); }, intervalMs);
  sweeper.unref?.();
}
export function stopDepositInstructionSweeper(): void { if (sweeper) { clearInterval(sweeper); sweeper = null; } }
