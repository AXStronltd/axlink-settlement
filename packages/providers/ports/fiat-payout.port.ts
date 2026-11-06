import type { OpStatus, ProviderHealth, WebhookInput } from './common';

export interface FiatPayoutProvider {
  readonly id: string;
  readonly currency: string;
  readonly rails: string[];                                                   // e.g. MPESA_B2C, PESALINK, FPS, SEPA, ACH
  payout(p: { clientRef: string; amount: string; rail: string; beneficiary: Record<string, string> }): Promise<{ providerRef: string; status: OpStatus; reason?: string }>;
  getPayout(providerRef: string): Promise<{ status: OpStatus; reason?: string }>;
  balance(): Promise<{ available: string }>;
  verifyWebhook(w: WebhookInput): boolean;
  parseWebhook(w: WebhookInput): { kind: 'PAYOUT_STATUS'; clientRef: string; status: OpStatus; reason?: string } | { kind: 'INBOUND_CREDIT'; providerRef: string; amount: string; currency: string; reference?: string; payerName?: string } | { kind: 'IGNORED' };
  health(): Promise<ProviderHealth>;
}
