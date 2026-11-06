/**
 * GET /api/settlements/:id — one status view over every settlement kind an institution can own.
 * Today the only kind is DEPOSIT (a deposit instruction); outbound transfers join in slice 3.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireInstitution, requireScope } from '../../../../packages/core/tenancy/tenancy.middleware';
import { getDepositInstruction, serializeInstruction } from '../../../../packages/settlement/deposits/deposit-instruction.service';

const router = Router();
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
router.use(requireInstitution, requireScope('settlements:read'));
router.get('/:id', wrap(async (req, res) => {
  const t = req.tenant!;
  res.json(await serializeInstruction(await getDepositInstruction(req.params.id as string, { institutionId: t.institutionId, environmentId: t.environmentId })));
}));
export default router;
