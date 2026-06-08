import crypto from 'crypto';
import { readFileSync } from 'fs';
import {
  Fireblocks,
  BasePath,
  TransferPeerPathType,
  TransactionOperation,
  FeeLevel,
} from '@fireblocks/ts-sdk';

function createClient(): Fireblocks {
  const apiKey = process.env.FIREBLOCKS_API_KEY;
  const keyPath = process.env.FIREBLOCKS_SECRET_KEY_PATH;
  const sandbox = process.env.FIREBLOCKS_SANDBOX === 'true';

  if (!apiKey || !keyPath) {
    throw new Error('FIREBLOCKS_API_KEY and FIREBLOCKS_SECRET_KEY_PATH must be set');
  }

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
  const res = await client().vaults.createVaultAccount({
    createVaultAccountRequest: { name, hiddenOnUI },
  });
  return res.data;
}

export async function getVaultAccount(vaultAccountId: string) {
  const res = await client().vaults.getVaultAccount({ vaultAccountId });
  return res.data;
}

export async function listVaultAccounts(limit = 20, after?: string) {
  const res = await client().vaults.getPagedVaultAccounts({
    limit,
    ...(after ? { after } : {}),
  });
  return res.data;
}

export async function getVaultAssetBalance(vaultAccountId: string, assetId: string) {
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
      note: params.note ?? 'FinCruse settlement',
      feeLevel: FEE_LEVEL_MAP[params.feeLevel ?? 'MEDIUM'],
      ...(params.externalTxId ? { externalTxId: params.externalTxId } : {}),
      treatAsGrossAmount: params.treatAsGrossAmount ?? false,
    },
  });

  return res.data;
}

export async function getTransaction(txId: string) {
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
  const res = await client().transactions.estimateNetworkFee({ assetId });
  return res.data;
}

// ── Assets ───────────────────────────────────────────────────────────────────

export async function getSupportedAssets() {
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
  if (!pubKey) return true; // skip if not configured (dev mode)

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
