/**
 * Solana as a `BlockchainProvider` (Step 2, slice 3). Wraps the runtime seam (`ports().chain`) so
 * the harness and tests can stub the node; the proof service and reconciliation call only this.
 */
import type { BlockchainProvider, AssetRef, ProviderHealth } from '../../ports';
import { ChainTransactionFailed } from '../../ports/blockchain.port';
import { ports } from '../../ports/runtime';
import { resolveByContract, ASSETS } from '../../../core/assets/registry';
import * as sol from './solana';

const CHAIN = 'solana-mainnet';
function contractOf(a: AssetRef): string {
  const hit = Object.values(ASSETS).find(x => x.symbol === a.symbol.toUpperCase() && x.network === CHAIN);
  if (!hit) throw new Error(`asset ${a.symbol} is not registered on ${CHAIN}`);
  return hit.contract;
}

export const solanaBlockchainProvider: BlockchainProvider = {
  chain: CHAIN,
  async getTransaction(txHash) {
    const tx = await ports().chain.getTransaction(txHash, sol.SETTLEMENT_COMMITMENT);
    if (!tx) return { found: false, finalized: false, failed: false, tokenMovements: [] };
    return { found: true, finalized: true, failed: !!tx.err, slot: tx.slot, blockTime: tx.blockTime, feeRaw: tx.feeLamports, error: tx.err,
      tokenMovements: tx.tokenTransfers.map(t => ({ contract: t.mint, owner: t.owner, decimals: t.decimals, changeRaw: t.changeRaw })) };
  },
  async awaitFinality(txHash, timeoutMs) {
    try {
      const s = await ports().chain.awaitFinality(txHash, { commitment: sol.SETTLEMENT_COMMITMENT, ...(timeoutMs ? { timeoutMs } : {}) } as never);
      return { finalized: true, slot: s.slot ?? undefined };
    } catch (e) {
      // Only a transaction that landed and failed is a definite failure. A deadline (node lagging,
      // rate-limited, signature not yet seen) is unknown: leave the settlement unproven and retryable.
      if (e instanceof sol.SettlementNotFinalError && e.reason === 'execution_error') throw new ChainTransactionFailed(txHash, e.message);
      throw Object.assign(e as Error, { retryable: true, code: (e as { code?: string }).code ?? 'CHAIN_UNAVAILABLE' });
    }
  },
  async getTokenBalanceRaw(address, asset) { return ports().chain.getTokenBalanceRaw(address, contractOf(asset)); },
  isValidAddress(address) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address); },
  async health(): Promise<ProviderHealth> {
    const t = Date.now();
    try { const h = await sol.health(); return { ok: h.ok, latencyMs: Date.now() - t, detail: h.error ?? (h.slot ? `slot ${h.slot}` : undefined) }; } catch (e) { return { ok: false, detail: (e as Error).message }; }
  },
};
export { resolveByContract };
