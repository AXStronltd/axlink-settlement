/** Operator-only institution administration (Step 1). Institution self-service comes with the portal in a later step. */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireOps } from '../platform/ops-auth';
import { createWallet, listInstitutionWallets, serializeWallet } from '../../../../packages/core/wallets/wallet.service';
import { createInstitution, getInstitution, listInstitutions, issueCredential, revokeCredential, CreateInstitution } from '../../../../packages/core/institutions/institution.service';
import { notFound } from '../../../../packages/shared/errors';
import { requireInstitution } from '../../../../packages/core/tenancy/tenancy.middleware';

/** Every scope the API checks. Issuing an unknown scope (a typo) is refused here rather than failing silently at call time. */
export const KNOWN_SCOPES = ['*', 'wallets:read', 'wallets:write', 'wallets:*', 'deposits:read', 'deposits:write', 'deposits:*', 'settlements:read', 'settlements:write', 'settlements:*', 'ledger:read', 'ledger:*', 'webhooks:read', 'webhooks:write', 'webhooks:*', 'counterparties:read', 'counterparties:write', 'counterparties:*', 'transfers:read', 'transfers:write', 'transfers:*'] as const;

const router = Router();
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// institution-facing: who am I (proves a credential works; the first endpoint any integrator calls)
router.get('/me', requireInstitution, (req, res) => { const t = req.tenant!; res.json({ institution: { id: t.institutionId, slug: t.institutionSlug }, environment: t.environmentKind, scopes: t.scopes }); });

router.use(requireOps);
router.post('/', wrap(async (req, res) => { const inst = await createInstitution(CreateInstitution.parse(req.body)); res.status(201).json(inst); }));
router.get('/', wrap(async (_req, res) => { res.json(await listInstitutions()); }));
router.get('/:id', wrap(async (req, res) => { const i = await getInstitution(req.params.id as string); if (!i) throw notFound('institution'); res.json(i); }));
router.post('/:id/credentials', wrap(async (req, res) => {
  const d = z.object({ environment: z.enum(['SANDBOX', 'PRODUCTION']), label: z.string().min(1).max(80), scopes: z.array(z.enum(KNOWN_SCOPES)).default([]) }).parse(req.body);
  const r = await issueCredential(req.params.id as string, d.environment, d.label, d.scopes);
  res.status(201).json({ credential: { id: r.credential.id, prefix: r.credential.prefix, label: r.credential.label, scopes: r.credential.scopes, environment: d.environment }, apiKey: r.rawKey, note: 'The API key is shown once. Store it in the institution\'s secret manager.' });
}));
router.post('/:id/credentials/:credId/revoke', wrap(async (req, res) => { res.json(await revokeCredential(req.params.credId as string)); }));
export default router;

// ── Wallets (Step 2) — operator creates; institutions read their own through /api/wallets ──
const CreateWallet = z.object({ environment: z.enum(['SANDBOX', 'PRODUCTION']), label: z.string().min(1).max(80), network: z.literal('solana-mainnet').optional() });
router.post('/:id/wallets', wrap(async (req, res) => {
  const body = CreateWallet.parse(req.body);
  const w = await createWallet({ institutionId: req.params.id as string, environmentKind: body.environment, label: body.label, network: body.network });
  res.status(201).json(await serializeWallet({ ...w, environment: { kind: body.environment } }));
}));
router.get('/:id/wallets', wrap(async (req, res) => {
  if (!(await getInstitution(req.params.id as string))) throw notFound('institution');
  res.json(await Promise.all((await listInstitutionWallets(req.params.id as string)).map(serializeWallet)));
}));
