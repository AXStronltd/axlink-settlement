/**
 * Fireblocks as a `CustodyProvider` (Step 2, slice 3).
 * Calls go through the runtime seam (`ports().custody`) where one exists so the settlement harness
 * can stub them; everything else calls the Fireblocks module directly. Core code sees only the port.
 */
import type { CustodyProvider, AssetRef, OpStatus, WebhookInput, ProviderHealth } from '../../ports';
import { ports } from '../../ports/runtime';
import { providerAssetId, resolveByContract, resolveProviderAsset, type AssetId, ASSETS } from '../../../core/assets/registry';
import * as fb from './fireblocks';
import { createVaultAssetAddress } from './fireblocks';
import { verifyFireblocksRequest, fireblocksVerificationConfigured } from './fireblocks-webhook';

function assetIdOf(a: AssetRef): AssetId {
  const hit = Object.values(ASSETS).find(x => x.symbol === a.symbol.toUpperCase() && (x.network === a.chain || x.network.startsWith(a.chain)));
  if (!hit) throw new Error(`asset ${a.symbol} on ${a.chain} is not in the registry`);
  return hit.id;
}
function toStatus(s: string | undefined): { status: OpStatus; final: boolean } {
  switch ((s ?? '').toUpperCase()) {
    case 'COMPLETED': return { status: 'CONFIRMED', final: true };
    case 'FAILED': case 'REJECTED': case 'CANCELLED': case 'BLOCKED': return { status: 'FAILED', final: true };
    default: return { status: 'PENDING', final: false };
  }
}

export const fireblocksCustodyProvider: CustodyProvider = {
  id: 'fireblocks',
  configured: () => fb.isConfigured(),
  async createVault(label, clientRef) {
    if (!fb.isConfigured()) return { vaultId: `vault_sbx_${clientRef.replace(/[^a-z0-9]/gi, '').slice(0, 12)}_${Date.now().toString(36)}` };
    const v = await fb.createVaultAccount(label, true);
    if (!v.id || String(v.id).includes('_sandbox_')) throw new Error('Fireblocks did not return a real vault id');
    return { vaultId: String(v.id) };
  },
  async getDepositAddress(vaultId, asset) {
    const id = assetIdOf(asset);
    if (!fb.isConfigured()) return { address: `sbx_${ASSETS[id].network}_${vaultId}`.slice(0, 44) };
    return createVaultAssetAddress(vaultId, providerAssetId('fireblocks', id));
  },
  async getBalance(vaultId, asset) {
    const r = await ports().custody.getVaultAssetBalance(vaultId, providerAssetId('fireblocks', assetIdOf(asset))) as { available?: string; pending?: string; total?: string };
    return { available: r.available ?? '0', pending: r.pending ?? '0', ...(r.total !== undefined ? { total: r.total } : {}) };
  },
  async transferInternal(p) {
    const r = await ports().custody.createTransfer({ assetId: providerAssetId('fireblocks', assetIdOf(p.asset)), amount: p.amount, sourceVaultId: p.fromVaultId, destVaultId: p.toVaultId, externalTxId: p.clientRef }) as { id: string; status?: string };
    return { providerTxId: r.id, ...toStatus(r.status) };
  },
  async transferExternal(p) {
    const r = await ports().custody.createTransfer({ assetId: providerAssetId('fireblocks', assetIdOf(p.asset)), amount: p.amount, sourceVaultId: p.fromVaultId, destAddress: p.toAddress, note: p.memo, externalTxId: p.clientRef }) as { id: string; status?: string; txHash?: string };
    return { providerTxId: r.id, ...toStatus(r.status), txHash: r.txHash };
  },
  async findTransferByClientRef(clientRef) {
    const t = await fb.getTransactionByExternalId(clientRef);
    return t ? { providerTxId: t.id, ...toStatus(t.status), txHash: t.txHash } : null;
  },
  async getTransfer(providerTxId) {
    const t = await ports().custody.getTransaction(providerTxId) as { status?: string; txHash?: string };
    return { ...toStatus(t.status), txHash: t.txHash };
  },
  async whitelistAddress() { throw new Error('whitelisting is managed in the Fireblocks console (Transaction Authorization Policy); not automated in Leg A'); },
  verifyWebhook(w: WebhookInput) {
    // Pinned-key path only (synchronous). The live route (webhook.routes.ts) is the admission point and
    // also verifies the async JWKS (v2) signature; this method must not be used as the sole gate.
    const sig = String(w.headers['fireblocks-signature'] ?? '');
    return fireblocksVerificationConfigured() && fb.verifyFireblocksWebhook(w.rawBody, sig);
  },
  parseWebhook(w: WebhookInput) {
    let body: { type?: string; data?: { id?: string; status?: string; assetId?: string; txHash?: string; externalTxId?: string; network?: string; contract?: string; source?: { id?: string; type?: string }; destination?: { id?: string; type?: string }; amountInfo?: { netAmount?: string }; netAmount?: number | string; operation?: string } };
    // Numeric amounts keep their original decimal lexeme (same reviver as the live route; Node 22+).
    try { body = JSON.parse(w.rawBody, (key: string, value: unknown, context?: { source?: string }) => (key === 'amount' || key === 'netAmount') && typeof value === 'number' ? (context?.source ?? String(value)) : value); } catch { return { kind: 'IGNORED' }; }
    const d = body.data; if (!d?.id) return { kind: 'IGNORED' };
    const asset = resolveProviderAsset('fireblocks', d.assetId);
    const st = toStatus(d.status);
    if (st.final && st.status === 'CONFIRMED' && d.operation === 'TRANSFER' && d.destination?.type === 'VAULT_ACCOUNT' && asset && d.destination.id && d.txHash) {
      return { kind: 'DEPOSIT', vaultId: d.destination.id, asset: { symbol: asset.symbol, chain: asset.network }, amount: String(d.amountInfo?.netAmount ?? d.netAmount ?? ''), txHash: d.txHash,
        providerTxId: d.id, externalTxId: d.externalTxId, network: d.network, contract: d.contract, sourceType: d.source?.type, sourceVaultId: d.source?.id };
    }
    return { kind: 'TRANSFER_STATUS', providerTxId: d.id, status: st.status, final: st.final, txHash: d.txHash };
  },
  async health(): Promise<ProviderHealth> {
    if (!fb.isConfigured()) return { ok: true, detail: 'sandbox stub (no credentials)' };
    const t = Date.now();
    try { await fb.getSupportedAssets(); return { ok: true, latencyMs: Date.now() - t }; } catch (e) { return { ok: false, detail: (e as Error).message }; }
  },
};
export { resolveByContract };
