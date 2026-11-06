/**
 * /api/v1 — the institution API contract (Step 2, slice 4), named exactly as the AxLink
 * Architecture Blueprint names it. This is the surface a bank integrates against; the older
 * `/api/wallets`, `/api/deposits/instructions`, `/api/settlements`, `/api/webhooks/endpoints`
 * routes stay mounted as aliases of the same services so nothing already integrated breaks.
 *
 *   GET  /v1/institutions/me             who am I, environment, permissions
 *   GET  /v1/assets                       supported assets and networks
 *   POST /v1/wallets · GET /v1/wallets · GET /v1/wallets/:id   (wallets:write / wallets:read)
 *   POST /v1/custody/deposit-addresses    receiving address for a wallet
 *   GET  /v1/balances                     balances by asset across the environment's wallets
 *   POST /v1/deposits · GET /v1/deposits · GET /v1/deposits/:id · POST /v1/deposits/:id/cancel
 *   GET  /v1/settlements/:id              status and proof
 *   GET  /v1/ledger/entries               authorised journal history (ledger:read)
 *   POST /v1/webhook-endpoints · GET · DELETE /:id
 *   POST /v1/transfers · POST /v1/settlements   501 until outbound settlement (slice 5)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../../packages/shared/errors';
import { requireInstitution, requireScope } from '../../../../packages/core/tenancy/tenancy.middleware';
import { ASSETS, NETWORKS } from '../../../../packages/core/assets/registry';
import { createWallet, getWallet, serializeWallet } from '../../../../packages/core/wallets/wallet.service';
import { institutionBalances, listInstitutionEntries } from '../../../../packages/core/ledger/statement.service';
import walletRoutes from './wallet.routes';
import depositInstructionRoutes from './deposit-instruction.routes';
import webhookEndpointRoutes from './webhook-endpoint.routes';
import { counterpartyRoutes, transferRoutes } from './transfer-v1.routes';
import { getTransfer, serializeTransfer } from '../../../../packages/settlement/transfers/settlement-transfer.service';
import { getDepositInstruction, serializeInstruction } from '../../../../packages/settlement/deposits/deposit-instruction.service';

const router = Router();
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

router.use(requireInstitution);

router.get('/institutions/me', (req, res) => {
  const t = req.tenant!;
  res.json({ institution: { id: t.institutionId, slug: t.institutionSlug }, environment: t.environmentKind, scopes: t.scopes, permissions: t.scopes });
});

router.get('/assets', (_req, res) => {
  res.json({
    assets: Object.values(ASSETS).filter(a => a.supported).map(a => ({ id: a.id, symbol: a.symbol, network: a.network, contract: a.contract, decimals: a.decimals, issuer: a.tokenIssuer })),
    networks: Object.values(NETWORKS).map(n => ({ id: n.id, family: n.family, finality: n.finality })),
  });
});

// Wallets: an institution provisions its own wallet in the environment its credential is bound to.
const CreateWallet = z.object({ label: z.string().min(1).max(80), network: z.literal('solana-mainnet').optional() });
router.post('/wallets', requireScope('wallets:write'), wrap(async (req, res) => {
  const t = req.tenant!; const b = CreateWallet.parse(req.body);
  const w = await createWallet({ institutionId: t.institutionId, environmentKind: t.environmentKind, label: b.label, network: b.network });
  res.status(201).json(await serializeWallet({ ...w, environment: { kind: t.environmentKind } }));
}));
// The institution designates which wallet receives network settlements in this environment (default: oldest ACTIVE).
router.post('/wallets/:id/settlement-default', requireScope('wallets:write'), wrap(async (req, res) => {
  const { setSettlementWallet } = await import('../../../../packages/settlement/transfers/counterparty.service');
  const t = req.tenant!; const w = await setSettlementWallet({ institutionId: t.institutionId, environmentId: t.environmentId }, req.params.id as string);
  res.json({ settlementWalletId: w.id, environment: t.environmentKind });
}));
router.use('/wallets', walletRoutes);

// One receiving address serves every supported asset on the wallet's network.
const DepositAddress = z.object({ walletId: z.string().min(1), asset: z.enum(['USDC_SOL', 'USDT_SOL']).optional() });
router.post('/custody/deposit-addresses', requireScope('wallets:read'), wrap(async (req, res) => {
  const t = req.tenant!; const b = DepositAddress.parse(req.body);
  const w = await getWallet(b.walletId, { institutionId: t.institutionId, environmentId: t.environmentId });
  if (w.status !== 'ACTIVE') throw new ApiError('WALLET_NOT_ACTIVE', `wallet is ${w.status}; it cannot receive`, 409);
  if (!w.depositAddress) throw new ApiError('ADDRESS_NOT_ISSUED', 'the custodian has not issued a receiving address for this wallet yet; retry shortly', 503);
  const assets = Object.values(ASSETS).filter(a => a.supported && a.network === w.network && (!b.asset || a.id === b.asset)).map(a => a.id);
  if (assets.length === 0) throw new ApiError('ASSET_NOT_ON_NETWORK', `${b.asset} is not available on ${w.network}`, 400);
  res.json({ walletId: w.id, network: w.network, address: w.depositAddress, assets, custody: { provider: w.custodyProvider, vaultId: w.custodyVaultId }, note: 'Send only the listed assets on the listed network to this address. Announce each deposit with POST /v1/deposits to receive a tracking id.' });
}));

router.get('/balances', requireScope('wallets:read'), wrap(async (req, res) => {
  const t = req.tenant!; res.json(await institutionBalances({ institutionId: t.institutionId, environmentId: t.environmentId }));
}));

// Outbound settlement (slice 5). POST /v1/settlements is the blueprint's name for the same action as
// POST /v1/transfers; GET /v1/settlements/{id} answers for a deposit instruction or a transfer.
router.use('/counterparties', counterpartyRoutes);
router.use('/transfers', transferRoutes);
router.post('/settlements', (req, _res, next) => { req.url = '/'; transferRoutes(req, _res, next); });
const settlementsRead = (req: Request, _res: Response, next: NextFunction) => {
  const have = req.tenant?.scopes ?? [];
  next(['settlements:read', 'settlements:*', 'transfers:read', 'transfers:*', 'deposits:read', 'deposits:*', '*'].some(s => have.includes(s)) ? undefined : new ApiError('FORBIDDEN', 'Credential lacks settlements:read', 403));
};
router.get('/settlements/:id', settlementsRead, wrap(async (req, res) => {
  const t = req.tenant!; const scope = { institutionId: t.institutionId, environmentId: t.environmentId }; const id = req.params.id as string;
  const transfer = await getTransfer(id, scope).catch(e => { if (e instanceof ApiError && e.statusCode === 404) return null; throw e; });
  if (transfer) { res.json(await serializeTransfer(transfer)); return; }
  res.json(await serializeInstruction(await getDepositInstruction(id, scope)));
}));

router.use('/deposits', depositInstructionRoutes);
router.use('/webhook-endpoints', webhookEndpointRoutes);

const Entries = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().max(120).optional(), asset: z.enum(['USDC_SOL', 'USDT_SOL']).optional(), entityType: z.string().max(40).optional(), entityId: z.string().max(80).optional() });
router.get('/ledger/entries', requireScope('ledger:read'), wrap(async (req, res) => {
  const t = req.tenant!; const q = Entries.parse(req.query);
  res.json(await listInstitutionEntries({ institutionId: t.institutionId, environmentId: t.environmentId }, q));
}));

export default router;
