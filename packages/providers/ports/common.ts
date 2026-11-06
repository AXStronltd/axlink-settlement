/** Shared value types used by every port. */
export interface AssetRef { symbol: string; chain: string; }
export type OpStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';
export interface ProviderHealth { ok: boolean; latencyMs?: number; detail?: string; }
export interface WebhookInput { rawBody: string; headers: Record<string, string | string[] | undefined>; }
