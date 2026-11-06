import crypto from 'crypto';
import { readFileSync } from 'fs';
import { log } from '../../../shared/logger';
import {
  Fireblocks,
  BasePath,
  TransferPeerPathType,
  TransactionOperation,
  FeeLevel,
} from '@fireblocks/ts-sdk';

const PLACEHOLDER = ['your_', 'YOUR_'];

export function isConfigured(): boolean {
  const apiKey = process.env.FIREBLOCKS_API_KEY ?? '';
  const keyPath = process.env.FIREBLOCKS_SECRET_KEY_PATH ?? '';
  return !!(apiKey && keyPath && !PLACEHOLDER.some(p => apiKey.startsWith(p)));
}

function stubId(prefix: string) {
  return `${prefix}_sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createClient(): Fireblocks {
  const apiKey = process.env.FIREBLOCKS_API_KEY!;
  const keyPath = process.env.FIREBLOCKS_SECRET_KEY_PATH!;
  const sandbox = process.env.FIREBLOCKS_SANDBOX === 'true';

  return new Fireblocks({
    apiKey,
    secretKey: readFileSync(keyPath, 'utf8'),
    basePath: sandbox ? BasePath.Sandbox : BasePath.US,
  });
}

// Lazy singleton — only initialised on first use so missing env vars don't crash boot
let _client: Fireblocks | null = null;
function client(): Fireblocks {
  if (!_client) _client = createClient();
  return _client;
}

// ── Vaults ───────────────────────────────────────────────────────────────────

export async function createVaultAccount(name: string, hiddenOnUI = true) {
  if (!isConfigured()) {
    console.warn('[fireblocks] Not configured — returning sandbox stub vault');
    return { id: stubId('vault'), name, hiddenOnUI };
  }
  try {
    const res = await client().vaults.createVaultAccount({
      createVaultAccountRequest: { name, hiddenOnUI },
    });
    return res.data;
  } catch (err: unknown) {
    console.warn('[fireblocks] createVaultAccount failed — returning sandbox stub:', (err as Error).message);
    return { id: stubId('vault'), name, hiddenOnUI };
  }
}

export async function getVaultAccount(vaultAccountId: string) {
  if (!isConfigured()) return { id: vaultAccountId, name: 'sandbox', assets: [] };
  const res = await client().vaults.getVaultAccount({ vaultAccountId });
  return res.data;
}

/**
 * Create (or fetch) the asset wallet inside a vault and return its deposit address.
 * Fireblocks issues one address per (vault, asset); on Solana the SPL tokens share the vault's
 * SOL address, so USDC_SOL and USDT_SOL return the same string. No stub on failure: an address we
 * invented is an address customers would send real money to.
 */
export async function createVaultAssetAddress(vaultAccountId: string, assetId: string): Promise<{ address: string; tag?: string }> {
  if (!isConfigured()) throw new Error('Fireblocks is not configured; cannot issue a deposit address');
  try {
    const res = await client().vaults.createVaultAccountAsset({ vaultAccountId, assetId });
    if (res.data.address) return { address: res.data.address, tag: res.data.tag ?? undefined };
  } catch (err: unknown) {
    // Asset wallet may already exist → read its first address.
    log.warn('fireblocks.create_vault_asset', { vaultAccountId, assetId, error: (err as Error).message });
  }
  const addrs = await client().vaults.getVaultAccountAssetAddressesPaginated({ vaultAccountId, assetId });
  const first = addrs.data.addresses?.[0];
  if (!first?.address) throw new Error(`Fireblocks returned no address for ${assetId} in vault ${vaultAccountId}`);
  return { address: first.address, tag: first.tag ?? undefined };
}

export async function listVaultAccounts(limit = 20, after?: string) {
  if (!isConfigured()) return { accounts: [], paging: {} };
  const res = await client().vaults.getPagedVaultAccounts({
    limit,
    ...(after ? { after } : {}),
  });
  return res.data;
}

export async function getVaultAssetBalance(vaultAccountId: string, assetId: string) {
  if (!isConfigured()) return { id: assetId, total: '0', available: '0' };
  const res = await client().vaults.getVaultAccountAsset({ vaultAccountId, assetId });
  return res.data;
}

// ── Transactions ─────────────────────────────────────────────────────────────

export interface TransferParams {
  assetId: string;
  amount: string;
  sourceVaultId: string;
  /** vault-to-vault move */
  destVaultId?: string;
  /** on-chain withdrawal to external address */
  destAddress?: string;
  note?: string;
  feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  externalTxId?: string;
  treatAsGrossAmount?: boolean;
}

const FEE_LEVEL_MAP: Record<string, FeeLevel> = {
  LOW: FeeLevel.Low,
  MEDIUM: FeeLevel.Medium,
  HIGH: FeeLevel.High,
};

export async function createTransfer(params: TransferParams) {
  if (!params.destVaultId && !params.destAddress) {
    throw new Error('Either destVaultId or destAddress must be provided');
  }

  if (!isConfigured()) {
    console.warn('[fireblocks] Not configured — returning sandbox stub transaction');
    return { id: stubId('tx'), status: 'COMPLETED', assetId: params.assetId, amount: params.amount };
  }

  try {
    const destination = params.destVaultId
      ? { type: TransferPeerPathType.VaultAccount, id: params.destVaultId }
      : { type: TransferPeerPathType.OneTimeAddress, oneTimeAddress: { address: params.destAddress! } };

    const res = await client().transactions.createTransaction({
      transactionRequest: {
        assetId: params.assetId,
        amount: params.amount,
        source: { type: TransferPeerPathType.VaultAccount, id: params.sourceVaultId },
        destination,
        operation: TransactionOperation.Transfer,
        note: params.note ?? 'AxLink settlement',
        feeLevel: FEE_LEVEL_MAP[params.feeLevel ?? 'MEDIUM'],
        ...(params.externalTxId ? { externalTxId: params.externalTxId } : {}),
        treatAsGrossAmount: params.treatAsGrossAmount ?? false,
      },
    });

    return res.data;
  } catch (err: unknown) {
    // Never fabricate a completed transaction for a live workspace: a rejected or timed-out
    // submission must surface as an error so the caller retries or reconciles by externalTxId.
    const e = err as Error & { response?: { status?: number; data?: { message?: string; code?: number } } };
    const message = e.response?.data?.message ?? e.message;
    throw Object.assign(new Error(`Fireblocks createTransaction failed: ${message}`), { code: 'CUSTODY_SUBMIT_FAILED', httpStatus: e.response?.status, providerCode: e.response?.data?.code, retryable: true });
  }
}

/** Resolve a transaction we may already have submitted (same externalTxId) — the recovery path after a timeout. */
export async function getTransactionByExternalId(externalTxId: string): Promise<{ id: string; status?: string; txHash?: string } | null> {
  if (!isConfigured()) return null;
  try {
    const res = await client().transactions.getTransactionByExternalId({ externalTxId });
    return res.data as { id: string; status?: string; txHash?: string };
  } catch (err: unknown) {
    const e = err as Error & { response?: { status?: number } };
    if (e.response?.status === 404) return null;
    throw err;
  }
}

export async function getTransaction(txId: string) {
  if (!isConfigured()) return { id: txId, status: 'COMPLETED' };
  const res = await client().transactions.getTransaction({ txId });
  return res.data;
}

export async function estimateTransferFee(params: {
  assetId: string;
  amount: string;
  sourceVaultId: string;
  destVaultId?: string;
  destAddress?: string;
}) {
  if (!isConfigured()) return { low: { networkFee: '0.0001' }, medium: { networkFee: '0.0002' }, high: { networkFee: '0.0004' } };

  const destination = params.destVaultId
    ? { type: TransferPeerPathType.VaultAccount, id: params.destVaultId }
    : { type: TransferPeerPathType.OneTimeAddress, oneTimeAddress: { address: params.destAddress! } };

  const res = await client().transactions.estimateTransactionFee({
    transactionRequest: {
      assetId: params.assetId,
      amount: params.amount,
      source: { type: TransferPeerPathType.VaultAccount, id: params.sourceVaultId },
      destination,
    },
  });

  return res.data;
}

export async function estimateNetworkFee(assetId: string) {
  if (!isConfigured()) return { low: { networkFee: '0.0001' }, medium: { networkFee: '0.0002' }, high: { networkFee: '0.0004' } };
  const res = await client().transactions.estimateNetworkFee({ assetId });
  return res.data;
}

// ── Assets ───────────────────────────────────────────────────────────────────

export async function getSupportedAssets() {
  if (!isConfigured()) return [];
  const res = await client().blockchainsAssets.getSupportedAssets();
  return res.data;
}

// ── Webhook signature verification ───────────────────────────────────────────
// Fireblocks signs webhook payloads with its RSA private key.
// Verify using the public key from Console → Webhooks → Public Key.

export function verifyFireblocksWebhook(
  rawBody: string,
  signatureHeader: string,
): boolean {
  const pubKey = process.env.FIREBLOCKS_WEBHOOK_PUBLIC_KEY ?? '';
  if (!pubKey || !signatureHeader) return false; // F2: fail closed — admission policy decides 503 vs 401

  try {
    return crypto.verify(
      'sha512',
      Buffer.from(rawBody),
      { key: pubKey, format: 'pem' as const },
      Buffer.from(signatureHeader, 'base64'),
    );
  } catch {
    return false;
  }
}

export const TX_STATUS: Record<string, string> = {
  SUBMITTED: 'submitted',
  QUEUED: 'queued',
  PENDING_SIGNATURE: 'pending_signature',
  PENDING_AUTHORIZATION: 'pending_authorization',
  BROADCASTING: 'broadcasting',
  CONFIRMING: 'confirming',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked',
};
