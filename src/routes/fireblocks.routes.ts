import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  createVaultAccount,
  getVaultAccount,
  listVaultAccounts,
  getVaultAssetBalance,
  createTransfer,
  getTransaction,
  estimateTransferFee,
  estimateNetworkFee,
  getSupportedAssets,
} from '../services/fireblocks.service';

const router = Router();

// ── Vaults ───────────────────────────────────────────────────────────────────

// POST /fireblocks/vaults — create a new vault account (e.g. per user)
router.post('/vaults', async (req: Request, res: Response) => {
  const { name, hiddenOnUI } = req.body as { name: string; hiddenOnUI?: boolean };
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const vault = await createVaultAccount(name, hiddenOnUI ?? true);
  res.status(201).json(vault);
});

// GET /fireblocks/vaults — list vault accounts
router.get('/vaults', async (req: Request, res: Response) => {
  const limit = Number(req.query['limit'] ?? 20);
  const after = req.query['after'] as string | undefined;
  const data = await listVaultAccounts(limit, after);
  res.json(data);
});

// GET /fireblocks/vaults/:id — get vault details + balances
router.get('/vaults/:id', async (req: Request, res: Response) => {
  const vault = await getVaultAccount(String(req.params['id']));
  res.json(vault);
});

// GET /fireblocks/vaults/:id/assets/:assetId — single asset balance
router.get('/vaults/:id/assets/:assetId', async (req: Request, res: Response) => {
  const balance = await getVaultAssetBalance(
    String(req.params['id']),
    String(req.params['assetId']),
  );
  res.json(balance);
});

// ── Transactions ─────────────────────────────────────────────────────────────

// POST /fireblocks/transfer — move funds between vaults or to external address
router.post('/transfer', async (req: Request, res: Response) => {
  const {
    assetId,
    amount,
    sourceVaultId,
    destVaultId,
    destAddress,
    note,
    feeLevel,
    treatAsGrossAmount,
  } = req.body as {
    assetId: string;
    amount: string;
    sourceVaultId: string;
    destVaultId?: string;
    destAddress?: string;
    note?: string;
    feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
    treatAsGrossAmount?: boolean;
  };

  if (!assetId || !amount || !sourceVaultId) {
    res.status(400).json({ error: 'assetId, amount, sourceVaultId are required' });
    return;
  }
  if (!destVaultId && !destAddress) {
    res.status(400).json({ error: 'Either destVaultId or destAddress is required' });
    return;
  }

  const tx = await createTransfer({
    assetId,
    amount,
    sourceVaultId,
    destVaultId,
    destAddress,
    note,
    feeLevel,
    treatAsGrossAmount,
    externalTxId: randomUUID(),
  });

  res.status(201).json(tx);
});

// GET /fireblocks/transfer/:txId — get transaction status
router.get('/transfer/:txId', async (req: Request, res: Response) => {
  const tx = await getTransaction(String(req.params['txId']));
  res.json(tx);
});

// ── Fee estimation ────────────────────────────────────────────────────────────

// POST /fireblocks/estimate-fee — estimate tx fee before submitting
router.post('/estimate-fee', async (req: Request, res: Response) => {
  const { assetId, amount, sourceVaultId, destVaultId, destAddress } = req.body as {
    assetId: string;
    amount: string;
    sourceVaultId: string;
    destVaultId?: string;
    destAddress?: string;
  };

  if (!assetId || !amount || !sourceVaultId) {
    res.status(400).json({ error: 'assetId, amount, sourceVaultId are required' });
    return;
  }

  const estimate = await estimateTransferFee({ assetId, amount, sourceVaultId, destVaultId, destAddress });
  res.json(estimate);
});

// GET /fireblocks/network-fee?assetId=ETH — current network fee tiers
router.get('/network-fee', async (req: Request, res: Response) => {
  const assetId = req.query['assetId'] as string | undefined;
  if (!assetId) { res.status(400).json({ error: 'assetId query param required' }); return; }
  const fee = await estimateNetworkFee(assetId);
  res.json(fee);
});

// ── Assets ────────────────────────────────────────────────────────────────────

// GET /fireblocks/assets — all supported assets
router.get('/assets', async (_req: Request, res: Response) => {
  const assets = await getSupportedAssets();
  res.json(assets);
});

export default router;
