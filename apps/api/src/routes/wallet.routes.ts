/**
 * Institution wallet API (Step 2, slice 1). Scoped by credential: an institution sees only the
 * wallets of its own institution AND environment. Scopes: `wallets:read`.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireInstitution, requireScope } from '../../../../packages/core/tenancy/tenancy.middleware';
import { listWallets, getWallet, serializeWallet } from '../../../../packages/core/wallets/wallet.service';

const router = Router();
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

router.use(requireInstitution, requireScope('wallets:read'));
router.get('/', wrap(async (req, res) => { const t = req.tenant!; res.json(await Promise.all((await listWallets(t.institutionId, t.environmentId)).map(serializeWallet))); }));
router.get('/:id', wrap(async (req, res) => { const t = req.tenant!; res.json(await serializeWallet(await getWallet(req.params.id as string, { institutionId: t.institutionId, environmentId: t.environmentId }))); }));
router.get('/:id/balances', wrap(async (req, res) => {
  const t = req.tenant!; const w = await getWallet(req.params.id as string, { institutionId: t.institutionId, environmentId: t.environmentId });
  res.json({ walletId: w.id, balances: (await serializeWallet(w)).balances });
}));

export default router;
