/**
 * B2BinPay as a `LiquidityProvider` (Step 2, slice 3): fiat ↔ USDC/USDT conversion.
 * Quotes come from the existing LP implementation (`b2binpayLP`); execution and order status go
 * through the runtime seam so the harness can stub them. Not used by Leg A deposit settlement —
 * registered so the role is visible and swappable; its flows are authorised separately.
 */
import type { LiquidityProvider, AssetRef, OpStatus, WebhookInput, ProviderHealth } from '../../ports';
import * as b2b from './b2binpay';

const PAIRS = [{ base: { symbol: 'USDT', chain: 'solana-mainnet' }, quote: 'USD' }, { base: { symbol: 'USDC', chain: 'solana-mainnet' }, quote: 'USD' }];
function toStatus(code: number | string | undefined): OpStatus {
  const label = typeof code === 'number' ? b2b.TRANSFER_STATUS[code] : String(code ?? '');
  if (label === 'confirmed' || label === 'completed') return 'CONFIRMED';
  if (label === 'failed' || label === 'canceled' || label === 'cancelled') return 'FAILED';
  return 'PENDING';
}

export const b2binpayLiquidityProvider: LiquidityProvider = {
  id: 'b2binpay',
  pairs: PAIRS,
  configured: () => b2b.isConfigured(),
  async quote(p) {
    const from = p.side === 'BUY' ? p.fiat : p.asset.symbol; const to = p.side === 'BUY' ? p.asset.symbol : p.fiat;
    const q = await b2b.b2binpayLP.requestQuote(from, to, Number(p.amount));
    const assetAmount = p.side === 'BUY' ? q.toAmount : q.fromAmount; const fiatAmount = p.side === 'BUY' ? q.fromAmount : q.toAmount;
    return { quoteId: q.id, rate: String(q.rate), assetAmount: String(assetAmount), fiatAmount: String(fiatAmount), expiresAt: new Date(q.validUntil) };
  },
  // Conversion execution is Leg B (fiat liquidity) and is not authorised in Leg A. Refusing here is
  // deliberate: a type-correct placeholder that creates real B2BinPay orders is worse than an error.
  async execute() { throw Object.assign(new Error('LIQUIDITY_EXECUTE_UNSUPPORTED: fiat conversion is Leg B and not enabled in Leg A'), { code: 'LIQUIDITY_EXECUTE_UNSUPPORTED', retryable: false }); },
  async getOrder() { throw Object.assign(new Error('LIQUIDITY_EXECUTE_UNSUPPORTED: fiat conversion is Leg B and not enabled in Leg A'), { code: 'LIQUIDITY_EXECUTE_UNSUPPORTED', retryable: false }); },
  verifyWebhook(w: WebhookInput) {
    const sig = String(w.headers['x-callback-signature'] ?? '');
    return b2b.isConfigured() && b2b.verifyWebhookSignature(w.rawBody, sig);
  },
  parseWebhook(w: WebhookInput) {
    let body: { data?: { id?: string; attributes?: { status?: number; amount?: string; tracking_id?: string } } };
    try { body = JSON.parse(w.rawBody); } catch { return { kind: 'IGNORED' }; }
    const a = body.data?.attributes; if (!a?.tracking_id) return { kind: 'IGNORED' };
    return { kind: 'ORDER_STATUS', clientRef: a.tracking_id, status: toStatus(a.status), filledAsset: a.amount ?? '0' };
  },
  async health(): Promise<ProviderHealth> {
    if (!b2b.isConfigured()) return { ok: true, detail: 'sandbox stub (no credentials)' };
    const t = Date.now();
    try { await b2b.getRates('USDT'); return { ok: true, latencyMs: Date.now() - t }; } catch (e) { return { ok: false, detail: (e as Error).message }; }
  },
};
