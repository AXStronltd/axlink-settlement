-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'INFO_REQUESTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "OnboardingApplication" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradingName" TEXT,
    "country" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "kind" TEXT NOT NULL,
    "website" TEXT,
    "registrationNumber" TEXT,
    "regulatoryLicence" TEXT,
    "licensingAuthority" TEXT,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactRole" TEXT,
    "webhookUrl" TEXT,
    "preferredAssets" TEXT[],
    "expectedVolume" TEXT,
    "corridors" TEXT[],
    "amlPolicyConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "uboDeclarationConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "termsAccepted" BOOLEAN NOT NULL DEFAULT false,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewNotes" TEXT,
    "rejectionReason" TEXT,
    "institutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingDocument" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "dataBase64" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingApplication_institutionId_key" ON "OnboardingApplication"("institutionId");

-- CreateIndex
CREATE INDEX "OnboardingApplication_status_submittedAt_idx" ON "OnboardingApplication"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "OnboardingApplication_contactEmail_idx" ON "OnboardingApplication"("contactEmail");

-- CreateIndex
CREATE INDEX "OnboardingDocument_applicationId_docType_idx" ON "OnboardingDocument"("applicationId", "docType");

-- AddForeignKey
ALTER TABLE "OnboardingApplication" ADD CONSTRAINT "OnboardingApplication_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingDocument" ADD CONSTRAINT "OnboardingDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "OnboardingApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
