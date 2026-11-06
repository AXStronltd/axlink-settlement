/**
 * /v1/counterparties and /v1/transfers (Step 2, slice 5) — outbound settlement for institutions.
 * Scopes: counterparties:read|write, transfers:read|write (settlements:* also accepted for transfers,
 * because the blueprint names POST /v1/settlements as the same action).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireInstitution, requireScope } from '../../../../packages/core/tenancy/tenancy.middleware';
import { registerCounterparty, listCounterparties, getCounterparty, disableCounterparty, serializeCounterparty } from '../../../../packages/settlement/transfers/counterparty.service';
import { createTransfer, getTransfer, listTransfers, cancelTransfer, serializeTransfer } from '../../../../packages/settlement/transfers/settlement-transfer.service';
import { ApiError } from '../../../../packages/shared/errors';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const scopeOf = (req: Request) => { const t = req.tenant!; return { institutionId: t.institutionId, environmentId: t.environmentId, environmentKind: t.environmentKind }; };

export const counterpartyRoutes = Router();
counterpartyRoutes.use(requireInstitution);
const RegisterCp = z.object({ label: z.string().min(1).max(80), address: z.string().min(16).max(128), network: z.literal('solana-mainnet').optional(), note: z.string().max(500).optional() });
counterpartyRoutes.post('/', requireScope('counterparties:write'), wrap(async (req, res) => {
  const cp = await registerCounterparty(scopeOf(req), RegisterCp.parse(req.body));
  res.status(201).json({ ...serializeCounterparty(cp), note: cp.status === 'ACTIVE' ? cp.note : 'Pending operator approval: the address must be whitelisted at the custodian before it can receive settlements.' });
}));
counterpartyRoutes.get('/', requireScope('counterparties:read'), wrap(async (req, res) => { res.json((await listCounterparties(scopeOf(req))).map(serializeCounterparty)); }));
counterpartyRoutes.get('/:id', requireScope('counterparties:read'), wrap(async (req, res) => { res.json(serializeCounterparty(await getCounterparty(req.params.id as string, scopeOf(req)))); }));
counterpartyRoutes.delete('/:id', requireScope('counterparties:write'), wrap(async (req, res) => { await disableCounterparty(req.params.id as string, scopeOf(req)); res.status(204).end(); }));

export const transferRoutes = Router();
transferRoutes.use(requireInstitution);
const CreateTransfer = z.object({ walletId: z.string().min(1), counterpartyId: z.string().min(1), asset: z.enum(['USDC_SOL', 'USDT_SOL']), amount: z.string().max(40).regex(/^\d{1,18}(\.\d{1,18})?$/), reference: z.string().max(140).optional() });
const writeScope = (req: Request, _res: Response, next: NextFunction) => {
  const have = req.tenant?.scopes ?? [];
  const ok = ['transfers:write', 'transfers:*', 'settlements:write', 'settlements:*', '*'].some(s => have.includes(s));
  next(ok ? undefined : new ApiError('FORBIDDEN', 'Credential lacks transfers:write', 403));
};
const readScope = (req: Request, _res: Response, next: NextFunction) => {
  const have = req.tenant?.scopes ?? [];
  const ok = ['transfers:read', 'transfers:*', 'settlements:read', 'settlements:*', '*'].some(s => have.includes(s));
  next(ok ? undefined : new ApiError('FORBIDDEN', 'Credential lacks transfers:read', 403));
};
transferRoutes.post('/', writeScope, wrap(async (req, res) => {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'send an Idempotency-Key header (8–128 chars, unique per transfer request)', 400);
  const { transfer, replayed } = await createTransfer(scopeOf(req), { ...CreateTransfer.parse(req.body), idempotencyKey: key });
  res.status(replayed ? 200 : 202).json(await serializeTransfer(await getTransfer(transfer.id, scopeOf(req))));
}));
transferRoutes.get('/', readScope, wrap(async (req, res) => {
  const rows = await listTransfers(scopeOf(req), typeof req.query.status === 'string' ? req.query.status : undefined);
  res.json(await Promise.all(rows.map(serializeTransfer)));
}));
transferRoutes.get('/:id', readScope, wrap(async (req, res) => { res.json(await serializeTransfer(await getTransfer(req.params.id as string, scopeOf(req)))); }));
transferRoutes.post('/:id/cancel', writeScope, wrap(async (req, res) => { await cancelTransfer(req.params.id as string, scopeOf(req)); res.json(await serializeTransfer(await getTransfer(req.params.id as string, scopeOf(req)))); }));
