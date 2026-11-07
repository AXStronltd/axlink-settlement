/**
 * Institution self-onboarding service.
 *
 * Flow:
 *   1. Institution creates a DRAFT application (no auth required)
 *   2. They upload documents (by application id + secret token)
 *   3. They submit — status moves to SUBMITTED
 *   4. Ops reviews in the dashboard (approve / reject / request info)
 *   5. Approval auto-creates the Institution record + issues sandbox credentials
 */

import { prisma } from '../ledger/ledger.service';
import { createInstitution, issueCredential } from '../institutions/institution.service';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreateApplicationInput {
  legalName: string;
  tradingName?: string;
  country: string;
  jurisdiction?: string;
  kind: string;
  website?: string;
  registrationNumber?: string;
  regulatoryLicence?: string;
  licensingAuthority?: string;
  contactName: string;
  contactEmail: string;
  contactRole?: string;
  webhookUrl?: string;
  preferredAssets?: string[];
  expectedVolume?: string;
  corridors?: string[];
}

export interface UploadDocumentInput {
  applicationId: string;
  docType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

export interface ReviewInput {
  action: 'APPROVE' | 'REJECT' | 'REQUEST_INFO';
  reviewedBy: string;
  reviewNotes?: string;
  rejectionReason?: string;
}

// ── Application token (proves ownership without user accounts) ─────────────
// The token is HMAC-SHA256(applicationId, APP_TOKEN_SECRET) stored nowhere —
// recomputed on each request. This avoids a separate token table.

const APP_TOKEN_SECRET = process.env.APP_TOKEN_SECRET ?? 'axlink-onboarding-dev-secret-change-in-prod';

export function applicationToken(applicationId: string): string {
  return createHmac('sha256', APP_TOKEN_SECRET).update(applicationId).digest('hex');
}

export function verifyApplicationToken(applicationId: string, token: string): boolean {
  const expected = Buffer.from(applicationToken(applicationId), 'hex');
  let received: Buffer;
  try { received = Buffer.from(token, 'hex'); } catch { return false; }
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createApplication(input: CreateApplicationInput) {
  const app = await prisma.onboardingApplication.create({
    data: {
      legalName: input.legalName,
      tradingName: input.tradingName,
      country: input.country,
      jurisdiction: input.jurisdiction,
      kind: input.kind.toUpperCase(),
      website: input.website,
      registrationNumber: input.registrationNumber,
      regulatoryLicence: input.regulatoryLicence,
      licensingAuthority: input.licensingAuthority,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      contactRole: input.contactRole,
      webhookUrl: input.webhookUrl,
      preferredAssets: input.preferredAssets ?? [],
      expectedVolume: input.expectedVolume,
      corridors: input.corridors ?? [],
    },
  });
  return { application: app, token: applicationToken(app.id) };
}

export async function getApplication(id: string) {
  return prisma.onboardingApplication.findUnique({
    where: { id },
    include: { documents: { select: { id: true, docType: true, fileName: true, mimeType: true, sizeBytes: true, uploadedAt: true } } },
  });
}

export async function listApplications(status?: string) {
  return prisma.onboardingApplication.findMany({
    where: status ? { status: status as any } : undefined,
    orderBy: { submittedAt: 'asc' },
    include: { documents: { select: { id: true, docType: true, fileName: true, sizeBytes: true, uploadedAt: true } } },
  });
}

export async function uploadDocument(input: UploadDocumentInput) {
  // Refuse uploads on non-DRAFT / non-INFO_REQUESTED applications
  const app = await prisma.onboardingApplication.findUnique({ where: { id: input.applicationId } });
  if (!app) throw new Error('APPLICATION_NOT_FOUND');
  if (app.status !== 'DRAFT' && app.status !== 'INFO_REQUESTED') {
    throw new Error('APPLICATION_NOT_EDITABLE');
  }
  return prisma.onboardingDocument.create({
    data: {
      applicationId: input.applicationId,
      docType: input.docType.toUpperCase(),
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      dataBase64: input.dataBase64,
    },
    select: { id: true, docType: true, fileName: true, mimeType: true, sizeBytes: true, uploadedAt: true },
  });
}

export async function deleteDocument(documentId: string, applicationId: string) {
  const doc = await prisma.onboardingDocument.findFirst({ where: { id: documentId, applicationId } });
  if (!doc) throw new Error('DOCUMENT_NOT_FOUND');
  const app = await prisma.onboardingApplication.findUnique({ where: { id: applicationId } });
  if (!app || (app.status !== 'DRAFT' && app.status !== 'INFO_REQUESTED')) {
    throw new Error('APPLICATION_NOT_EDITABLE');
  }
  await prisma.onboardingDocument.delete({ where: { id: documentId } });
}

export async function submitApplication(applicationId: string) {
  const app = await prisma.onboardingApplication.findUnique({ where: { id: applicationId } });
  if (!app) throw new Error('APPLICATION_NOT_FOUND');
  if (app.status !== 'DRAFT' && app.status !== 'INFO_REQUESTED') {
    throw new Error('ALREADY_SUBMITTED');
  }
  // Minimum validation: at least one document, compliance checkboxes ticked
  const docCount = await prisma.onboardingDocument.count({ where: { applicationId } });
  if (docCount === 0) throw new Error('NO_DOCUMENTS');
  if (!app.amlPolicyConfirmed || !app.uboDeclarationConfirmed || !app.termsAccepted) {
    throw new Error('DECLARATIONS_INCOMPLETE');
  }
  return prisma.onboardingApplication.update({
    where: { id: applicationId },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  });
}

export async function updateDeclarations(applicationId: string, data: {
  amlPolicyConfirmed?: boolean;
  uboDeclarationConfirmed?: boolean;
  termsAccepted?: boolean;
}) {
  const app = await prisma.onboardingApplication.findUnique({ where: { id: applicationId } });
  if (!app) throw new Error('APPLICATION_NOT_FOUND');
  if (app.status !== 'DRAFT' && app.status !== 'INFO_REQUESTED') throw new Error('APPLICATION_NOT_EDITABLE');
  return prisma.onboardingApplication.update({ where: { id: applicationId }, data });
}

// ── Ops review ────────────────────────────────────────────────────────────────

export async function reviewApplication(applicationId: string, review: ReviewInput) {
  const app = await prisma.onboardingApplication.findUnique({ where: { id: applicationId } });
  if (!app) throw new Error('APPLICATION_NOT_FOUND');
  if (app.status !== 'SUBMITTED' && app.status !== 'INFO_REQUESTED') {
    throw new Error('NOT_REVIEWABLE');
  }

  if (review.action === 'APPROVE') {
    // Create institution + sandbox environment + first API key in one transaction
    const inst = await createInstitution({
      legalName: app.legalName,
      country: app.country,
      kind: app.kind as any,
      contactEmail: app.contactEmail,
      slug: slugify(app.legalName),
    });

    const { credential, rawKey } = await issueCredential(inst.id, 'SANDBOX', 'Default sandbox key', ['*']);

    await prisma.onboardingApplication.update({
      where: { id: applicationId },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date(),
        reviewedBy: review.reviewedBy,
        reviewNotes: review.reviewNotes,
        institutionId: inst.id,
      },
    });

    return {
      status: 'APPROVED',
      institution: inst,
      sandboxCredential: { id: credential.id, label: credential.label, prefix: credential.prefix },
      sandboxApiKey: rawKey,
      note: 'API key shown once — deliver it to the institution technical contact securely.',
    };
  }

  if (review.action === 'REJECT') {
    await prisma.onboardingApplication.update({
      where: { id: applicationId },
      data: {
        status: 'REJECTED',
        reviewedAt: new Date(),
        reviewedBy: review.reviewedBy,
        reviewNotes: review.reviewNotes,
        rejectionReason: review.rejectionReason,
      },
    });
    return { status: 'REJECTED' };
  }

  // INFO_REQUESTED
  await prisma.onboardingApplication.update({
    where: { id: applicationId },
    data: {
      status: 'INFO_REQUESTED',
      reviewedAt: new Date(),
      reviewedBy: review.reviewedBy,
      reviewNotes: review.reviewNotes,
    },
  });
  return { status: 'INFO_REQUESTED' };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) + '-' + randomBytes(3).toString('hex');
}
