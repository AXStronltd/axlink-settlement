/**
 * Settlement proof.
 *
 * Turns a custodian's promise into evidence.
 *
 *   1. Ask Fireblocks for the transaction's on-chain hash.
 *   2. Ask a Solana RPC node whether that signature is finalized.
 *   3. Check the token movement on chain matches what we intended to settle.
 *   4. Record the result immutably.
 *
 * Step 3 is the one that is easy to skip and shouldn't be. A signature that
 * finalized proves *a* transaction happened; comparing the mint and the amount
 * proves it was *ours*. Without it, a proof is a hash we copied from an API
 * response and never checked.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../core/ledger/ledger.service';
import { providers } from '../../providers/registry/provider-registry';
import { ChainTransactionFailed } from '../../providers/ports/blockchain.port';
import { ASSETS, assetForSymbolOnNetwork, isAssetId, toMinorUnits, fromMinorUnits, type AssetDefinition, type AssetId } from '../../core/assets/registry';

/** Kept for callers that still pass a symbol; the registry asset is resolved below. */
export const SETTLEMENT_COMMITMENT = 'finalized';
export { ChainTransactionFailed as SettlementNotFinalError };

export interface ProveParams {
  entityType: string;
  entityId: string;
  /** Custody transaction id, when settlement was signed by the custodian. */
  custodyTxId?: string;
  /** On-chain signature, when already known. One of this or custodyTxId is required. */
  signature?: string;
  /** Registry asset id (USDC_SOL) or a symbol on the default network (USDC). */
  asset: AssetId | 'USDC' | 'USDT' | string;
  /** Decimal amount we intended to settle, for the on-chain amount check. */
  expectedAmount: Prisma.Decimal | string | number;
  fromAddress?: string;
  toAddress?: string;
  /** Tolerance for the amount check, as a fraction. Default 0 — exact match. */
  tolerance?: number;
}

export class ProofMismatchError extends Error {
  readonly code = 'SETTLEMENT_PROOF_MISMATCH';
  readonly statusCode = 500;
  /**
   * Never retry. The chain moved the wrong amount, or moved a different asset.
   * A second look at the same signature returns the same answer, so retrying
   * only delays the compensation and keeps the customer's money in suspense.
   */
  readonly retryable = false;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Extract the chain hash from a Fireblocks transaction.
 *
 * Returns null while the transaction is still queued, pending signature or
 * broadcasting — that is a normal intermediate state, not an error, and the
 * caller should retry rather than fail the settlement.
 */
export async function resolveChainHash(custodyTxId: string): Promise<string | null> {
  // Guard against a sandbox stub that fabricates an id and reports COMPLETED. Treating that as
  // settlement is exactly the failure this module exists to prevent.
  if (custodyTxId.includes('_sandbox_')) {
    throw new ProofMismatchError(
      `Refusing to prove settlement for stub custody transaction '${custodyTxId}'. ` +
      `The custody provider returned a synthetic id, which means it is unconfigured or erroring. No settlement occurred.`,
    );
  }
  const t = await providers.custody().getTransfer(custodyTxId);
  return t.txHash && t.txHash.length > 0 ? t.txHash : null;
}

function resolveAsset(asset: string): AssetDefinition {
  if (isAssetId(asset)) return ASSETS[asset];
  return assetForSymbolOnNetwork(asset);
}

/**
 * Verify and record an on-chain settlement.
 *
 * Idempotent on `signature` — replaying returns the stored proof rather than
 * re-verifying, so the resume worker can call this freely.
 */
export async function proveSettlement(params: ProveParams) {
  const { entityType, entityId, custodyTxId } = params;
  let assetDef: AssetDefinition;
  try { assetDef = resolveAsset(params.asset); } catch { throw new Error(`Unknown settlement asset '${params.asset}'`); }
  const asset = assetDef.symbol;
  const mintInfo = { mint: assetDef.contract, decimals: assetDef.decimals };
  const chain = providers.blockchain(assetDef.network);

  let signature = params.signature ?? null;

  if (!signature) {
    if (!custodyTxId) {
      throw new Error('proveSettlement requires either a signature or a custodyTxId');
    }
    signature = await resolveChainHash(custodyTxId);
    if (!signature) {
      // Not an error — the custodian has not broadcast yet.
      return { status: 'PENDING_BROADCAST' as const, signature: null, proof: null };
    }
  }

  const existing = await prisma.settlementProof.findUnique({ where: { signature } });

  // A proof row is written for failures too — that is how an on-chain error is
  // preserved rather than discarded. So "a row exists" does not mean "it
  // settled". Reading a failure row back as ALREADY_PROVEN let a transaction
  // that landed and failed complete its leg on the next attempt: the first
  // attempt recorded the failure, the second found the record and called it
  // proof. Only a row with no onchainError is evidence of settlement.
  if (existing && !existing.onchainError) {
    return { status: 'ALREADY_PROVEN' as const, signature, proof: existing };
  }
  if (existing?.onchainError) {
    throw new ProofMismatchError(
      `Signature ${signature} already failed on chain and cannot settle: ${existing.onchainError}`,
    );
  }

  // 1 — finality. Distinguish "failed on chain" from "cannot reach a node":
  //     the first is a settlement failure, the second says nothing at all.
  let status: { finalized: true; slot?: number };
  try {
    status = await chain.awaitFinality(signature);
  } catch (err) {
    if (err instanceof ChainTransactionFailed) {
      await recordFailure(entityType, entityId, signature, mintInfo.mint, err.message);
      throw err;
    }
    // RPC unreachable — leave the settlement unproven and retryable.
    throw Object.assign(
      new Error(`Cannot verify settlement ${signature}: ${(err as Error).message}`),
      { code: 'PROOF_UNAVAILABLE', retryable: true },
    );
  }

  // 2 — detail, for the amount check and the fee record.
  const tx = await chain.getTransaction(signature);
  if (!tx.found) {
    throw Object.assign(
      new Error(`Signature ${signature} is finalized but the node returned no transaction detail`),
      { code: 'PROOF_UNAVAILABLE', retryable: true },
    );
  }

  // 3 — did the right amount of the right asset actually move?
  if (tx.failed) {
    await recordFailure(entityType, entityId, signature, mintInfo.mint, tx.error ?? 'failed on chain');
    throw new ChainTransactionFailed(signature, tx.error ?? 'failed on chain');
  }
  const expectedRaw = toMinorUnits(new Prisma.Decimal(params.expectedAmount).toFixed(mintInfo.decimals), assetDef);
  const credited = tx.tokenMovements
    .filter(t => t.contract === mintInfo.mint && t.changeRaw > 0n)
    .reduce((s, t) => s + t.changeRaw, 0n);

  if (credited === 0n) {
    throw new ProofMismatchError(
      `Transaction ${signature} finalized but moved no ${asset} (contract ${mintInfo.mint}). ` +
      `Token movements seen: ${tx.tokenMovements.map(t => `${t.contract}:${t.changeRaw}`).join(', ') || 'none'}`,
    );
  }
  const formatUnits = (raw: bigint, decimals: number) => fromMinorUnits(raw, { ...assetDef, decimals }).toFixed();

  const tolerance = params.tolerance ?? 0;
  const drift = absDiff(credited, expectedRaw);
  const allowed = tolerance > 0 ? BigInt(Math.floor(Number(expectedRaw) * tolerance)) : 0n;

  if (drift > allowed) {
    throw new ProofMismatchError(
      `Settlement amount mismatch on ${signature}: expected ${formatUnits(expectedRaw, mintInfo.decimals)} ${asset}, ` +
      `chain credited ${formatUnits(credited, mintInfo.decimals)} ${asset}`,
    );
  }

  // 4 — record.
  const proof = await prisma.settlementProof.create({
    data: {
      entityType,
      entityId,
      signature,
      slot: BigInt(status.slot ?? tx.slot ?? 0),
      blockTime: tx.blockTime ?? null,
      commitment: SETTLEMENT_COMMITMENT,
      mint: mintInfo.mint,
      amountRaw: credited.toString(),
      decimals: mintInfo.decimals,
      amount: new Prisma.Decimal(formatUnits(credited, mintInfo.decimals)),
      fromAddress: params.fromAddress ?? '',
      toAddress: params.toAddress ?? '',
      feeLamports: tx.feeRaw ?? null,
      custodyTxId: custodyTxId ?? null,
    },
  });

  console.log(
    `[proof] ${entityType}:${entityId} settled — ${formatUnits(credited, mintInfo.decimals)} ${asset} ` +
    `finalized in slot ${proof.slot}, fee ${tx.feeRaw ?? 0n} lamports, sig ${signature}`,
  );

  return { status: 'PROVEN' as const, signature, proof };
}

async function recordFailure(
  entityType: string,
  entityId: string,
  signature: string,
  mint: string,
  error: string,
): Promise<void> {
  await prisma.settlementProof
    .create({
      data: {
        entityType,
        entityId,
        signature,
        slot: BigInt(0),
        commitment: 'none',
        mint,
        amountRaw: '0',
        decimals: 0,
        amount: new Prisma.Decimal(0),
        fromAddress: '',
        toAddress: '',
        onchainError: error,
      },
    })
    .catch(() => {
      /* proof row already exists — the error is already on record */
    });
}

/** Every proof for one entity, newest first. Used by the public status endpoint. */
export async function proofsFor(entityType: string, entityId: string) {
  const proofs = await prisma.settlementProof.findMany({
    where: { entityType, entityId },
    orderBy: { verifiedAt: 'desc' },
  });

  return proofs.map(p => ({
    signature: p.signature,
    slot: p.slot.toString(),
    blockTime: p.blockTime,
    commitment: p.commitment,
    asset: assetForMint(p.mint),
    amount: p.amount.toString(),
    feeLamports: p.feeLamports?.toString() ?? null,
    onchainError: p.onchainError,
    verifiedAt: p.verifiedAt,
    /** Anyone can check this without trusting us. That is the point. */
    explorerUrl: `https://solscan.io/tx/${p.signature}`,
  }));
}

function assetForMint(mint: string): string {
  const hit = Object.values(ASSETS).find(a => a.contract === mint);
  return hit?.symbol ?? mint;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}
