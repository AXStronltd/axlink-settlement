/**
 * Institution self-onboarding API
 *
 * Public endpoints (no API key required — authenticated by application token):
 *   POST   /api/onboarding                     — create application, returns {applicationId, token}
 *   GET    /api/onboarding/:id?token=<tok>      — get application + document list
 *   PATCH  /api/onboarding/:id?token=<tok>      — update declarations
 *   POST   /api/onboarding/:id/documents?token= — upload document (base64 body)
 *   DELETE /api/onboarding/:id/documents/:docId?token= — remove document
 *   POST   /api/onboarding/:id/submit?token=    — submit for review
 *
 * Ops-only endpoints (OPS_API_KEY):
 *   GET    /api/onboarding                      — list all applications (ops only, with ?status=)
 *   POST   /api/onboarding/:id/review           — approve / reject / request info
 *   GET    /api/onboarding/:id/documents/:docId/download — download raw file
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireOps } from '../platform/ops-auth';
import {
  createApplication,
  getApplication,
  listApplications,
  uploadDocument,
  deleteDocument,
  submitApplication,
  updateDeclarations,
  reviewApplication,
  verifyApplicationToken,
} from '../../../../packages/core/onboarding/onboarding.service';
import { ApiError } from '../../../../packages/shared/errors';

const router = Router();
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ── Token middleware ───────────────────────────────────────────────────────────

function requireToken(req: Request, _res: Response, next: NextFunction) {
  const token = (req.query['token'] as string) || req.headers['x-onboarding-token'] as string;
  const id = req.params['id'] as string;
  if (!token || !verifyApplicationToken(id, token)) {
    return next(new ApiError('UNAUTHORIZED', 'Invalid or missing onboarding token', 401));
  }
  next();
}

// ── Create application (public) ───────────────────────────────────────────────

const CreateSchema = z.object({
  legalName: z.string().min(2).max(200),
  tradingName: z.string().max(200).optional(),
  country: z.string().length(2).toUpperCase(),
  jurisdiction: z.string().max(100).optional(),
  kind: z.enum(['BANK', 'PSP', 'FINTECH', 'MSB', 'EXCHANGE', 'OTHER']),
  website: z.string().url().optional().or(z.literal('')),
  registrationNumber: z.string().max(100).optional(),
  regulatoryLicence: z.string().max(200).optional(),
  licensingAuthority: z.string().max(200).optional(),
  contactName: z.string().min(2).max(200),
  contactEmail: z.string().email(),
  contactRole: z.string().max(100).optional(),
  webhookUrl: z.string().url().optional().or(z.literal('')),
  preferredAssets: z.array(z.enum(['USDT', 'USDC'])).default(['USDT', 'USDC']),
  expectedVolume: z.string().max(100).optional(),
  corridors: z.array(z.string().max(20)).default([]),
});

router.post('/', wrap(async (req, res) => {
  const input = CreateSchema.parse(req.body);
  const { application, token } = await createApplication(input);
  res.status(201).json({
    applicationId: application.id,
    status: application.status,
    token,
    note: 'Save this token — it authenticates all future requests for this application.',
  });
}));

// ── Ops: list all applications ────────────────────────────────────────────────

router.get('/', requireOps, wrap(async (req, res) => {
  const status = req.query['status'] as string | undefined;
  const apps = await listApplications(status);
  res.json({ applications: apps, count: apps.length });
}));

// ── Get application (token auth) ──────────────────────────────────────────────

router.get('/:id', requireToken, wrap(async (req, res) => {
  const app = await getApplication(req.params['id'] as string);
  if (!app) throw new ApiError('NOT_FOUND', 'Application not found', 404);
  // Strip base64 from document list in applicant view
  res.json({ application: app });
}));

// ── Ops: get application (full) ───────────────────────────────────────────────

router.get('/:id/ops', requireOps, wrap(async (req, res) => {
  const app = await getApplication(req.params['id'] as string);
  if (!app) throw new ApiError('NOT_FOUND', 'Application not found', 404);
  res.json({ application: app });
}));

// ── Update declarations (token auth) ─────────────────────────────────────────

const DeclarationsSchema = z.object({
  amlPolicyConfirmed: z.boolean().optional(),
  uboDeclarationConfirmed: z.boolean().optional(),
  termsAccepted: z.boolean().optional(),
});

router.patch('/:id', requireToken, wrap(async (req, res) => {
  const data = DeclarationsSchema.parse(req.body);
  const app = await updateDeclarations(req.params['id'] as string, data);
  res.json({ application: { id: app.id, status: app.status, amlPolicyConfirmed: app.amlPolicyConfirmed, uboDeclarationConfirmed: app.uboDeclarationConfirmed, termsAccepted: app.termsAccepted } });
}));

// ── Upload document (token auth) ──────────────────────────────────────────────

const UploadSchema = z.object({
  docType: z.enum(['LICENCE', 'CERTIFICATE_OF_INCORPORATION', 'AML_POLICY', 'UBO_DECLARATION', 'ID_DOCUMENT', 'PROOF_OF_ADDRESS', 'OTHER']),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024), // 10 MB max
  dataBase64: z.string().min(1),
});

router.post('/:id/documents', requireToken, wrap(async (req, res) => {
  const input = UploadSchema.parse(req.body);
  const doc = await uploadDocument({ applicationId: req.params['id'] as string, ...input });
  res.status(201).json({ document: doc });
}));

// ── Delete document (token auth) ──────────────────────────────────────────────

router.delete('/:id/documents/:docId', requireToken, wrap(async (req, res) => {
  await deleteDocument(req.params['docId'] as string, req.params['id'] as string);
  res.status(204).send();
}));

// ── Submit (token auth) ───────────────────────────────────────────────────────

router.post('/:id/submit', requireToken, wrap(async (req, res) => {
  const app = await submitApplication(req.params['id'] as string);
  res.json({ application: { id: app.id, status: app.status, submittedAt: app.submittedAt } });
}));

// ── Ops: review ───────────────────────────────────────────────────────────────

const ReviewSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'REQUEST_INFO']),
  reviewedBy: z.string().email(),
  reviewNotes: z.string().max(2000).optional(),
  rejectionReason: z.string().max(1000).optional(),
});

router.post('/:id/review', requireOps, wrap(async (req, res) => {
  const review = ReviewSchema.parse(req.body);
  const result = await reviewApplication(req.params['id'] as string, review);
  res.json(result);
}));

// ── Ops: download document ────────────────────────────────────────────────────

router.get('/:id/documents/:docId/download', requireOps, wrap(async (req, res) => {
  const doc = await (await import('../../../../packages/core/ledger/ledger.service')).prisma.onboardingDocument.findFirst({
    where: { id: req.params['docId'] as string, applicationId: req.params['id'] as string },
  });
  if (!doc) throw new ApiError('NOT_FOUND', 'Document not found', 404);
  const buf = Buffer.from(doc.dataBase64, 'base64');
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
}));

export default router;
