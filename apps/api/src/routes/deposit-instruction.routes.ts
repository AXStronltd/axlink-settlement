/** Institution deposit instructions (Step 2, slice 2). Scopes: deposits:write / deposits:read. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireInstitution, requireScope } from '../../../../packages/core/tenancy/tenancy.middleware';
import { createDepositInstruction, getDepositInstruction, listDepositInstructions, cancelDepositInstruction, serializeInstruction } from '../../../../packages/settlement/deposits/deposit-instruction.service';

const router = Router();
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const Create = z.object({ walletId: z.string().min(1), asset: z.enum(['USDC_SOL', 'USDT_SOL']), amount: z.string().regex(/^\d+(\.\d+)?$/), reference: z.string().max(140).optional(), ttlHours: z.number().int().min(1).max(720).optional() });

router.use(requireInstitution);
router.post('/', requireScope('deposits:write'), wrap(async (req, res) => {
  const t = req.tenant!; const b = Create.parse(req.body);
  const { instruction, depositAddress } = await createDepositInstruction({ institutionId: t.institutionId, environmentId: t.environmentId, ...b });
  res.status(201).json(await serializeInstruction(instruction, depositAddress));
}));
router.get('/', requireScope('deposits:read'), wrap(async (req, res) => {
  const t = req.tenant!; const rows = await listDepositInstructions({ institutionId: t.institutionId, environmentId: t.environmentId }, typeof req.query.status === 'string' ? req.query.status : undefined);
  res.json(await Promise.all(rows.map(r => serializeInstruction(r))));
}));
router.get('/:id', requireScope('deposits:read'), wrap(async (req, res) => {
  const t = req.tenant!; res.json(await serializeInstruction(await getDepositInstruction(req.params.id as string, { institutionId: t.institutionId, environmentId: t.environmentId })));
}));
router.post('/:id/cancel', requireScope('deposits:write'), wrap(async (req, res) => {
  const t = req.tenant!; await cancelDepositInstruction(req.params.id as string, { institutionId: t.institutionId, environmentId: t.environmentId });
  res.json(await serializeInstruction(await getDepositInstruction(req.params.id as string, { institutionId: t.institutionId, environmentId: t.environmentId })));
}));
export default router;
