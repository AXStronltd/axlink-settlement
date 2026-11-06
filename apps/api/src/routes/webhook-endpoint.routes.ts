/** Institution webhook endpoints (Step 2, slice 2). Scopes: webhooks:write / webhooks:read. */
import { prisma } from '../../../../packages/core/ledger/ledger.service';
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
/** Recent deliveries to one of the institution's endpoints: event, attempts, last status, next retry. */
router.get('/:id/deliveries', requireScope('webhooks:read'), wrap(async (req, res) => {
  const t = req.tenant!;
  const ep = await prisma.webhookEndpoint.findFirst({ where: { id: req.params.id as string, institutionId: t.institutionId, environmentId: t.environmentId } });
  if (!ep) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'endpoint not found' } }); return; }
  // Scoped by endpoint id, never by URL: two institutions may share an ingress URL and must not see each other's history.
  const rows = await prisma.outboxEvent.findMany({ where: { channel: 'institution.webhook', webhookEndpointId: ep.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json(rows.map(r => ({ id: (r.payload as { id?: string })?.id ?? r.id, type: r.eventType, status: r.status, attempts: r.attempts, lastStatus: r.lastStatus, nextAttemptAt: r.status === 'PENDING' ? r.nextAttemptAt : null, entityType: r.entityType, entityId: r.entityId, createdAt: r.createdAt })));
}));
export default router;
