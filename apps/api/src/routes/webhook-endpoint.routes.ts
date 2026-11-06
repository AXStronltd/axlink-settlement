/** Institution webhook endpoints (Step 2, slice 2). Scopes: webhooks:write / webhooks:read. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireInstitution, requireScope } from '../../../../packages/core/tenancy/tenancy.middleware';
import { createEndpoint, listEndpoints, disableEndpoint, INSTITUTION_EVENTS } from '../../../../packages/core/webhooks/webhook-endpoint.service';

const router = Router();
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
router.use(requireInstitution);
router.post('/', requireScope('webhooks:write'), wrap(async (req, res) => {
  const t = req.tenant!; const b = z.object({ url: z.string().url(), events: z.array(z.string()).min(1).optional() }).parse(req.body);
  const r = await createEndpoint({ institutionId: t.institutionId, environmentId: t.environmentId }, b.url, b.events);
  res.status(201).json({ ...r.endpoint, secret: r.secret, note: 'Store the secret now; it is not shown again. Verify X-AxLink-Signature: t=<unix seconds>,v1=HMAC-SHA256(secret, t + "." + body).', events: r.endpoint.events, availableEvents: INSTITUTION_EVENTS });
}));
router.get('/', requireScope('webhooks:read'), wrap(async (req, res) => { const t = req.tenant!; res.json(await listEndpoints({ institutionId: t.institutionId, environmentId: t.environmentId })); }));
router.delete('/:id', requireScope('webhooks:write'), wrap(async (req, res) => { const t = req.tenant!; await disableEndpoint(req.params.id as string, { institutionId: t.institutionId, environmentId: t.environmentId }); res.status(204).end(); }));
export default router;
