import type { AssetRef, OpStatus, ProviderHealth, WebhookInput } from './common';

export interface LiquidityProvider {
  readonly id: string;
  readonly pairs: { base: AssetRef | string; quote: string }[];                 // e.g. USDT ↔ USD, USDT ↔ GBP
  quote(p: { side: 'BUY' | 'SELL'; asset: AssetRef; fiat: string; amount: string; amountIn: 'ASSET' | 'FIAT' }): Promise<{ quoteId: string; rate: string; assetAmount: string; fiatAmount: string; expiresAt: Date }>;
  execute(p: { quoteId: string; clientRef: string }): Promise<{ orderId: string; status: OpStatus }>;
  getOrder(orderId: string): Promise<{ status: OpStatus; filledAsset: string; filledFiat: string }>;
  verifyWebhook(w: WebhookInput): boolean;
  parseWebhook(w: WebhookInput): { kind: 'ORDER_STATUS'; clientRef: string; status: OpStatus; filledAsset: string } | { kind: 'IGNORED' };
  health(): Promise<ProviderHealth>;
}
