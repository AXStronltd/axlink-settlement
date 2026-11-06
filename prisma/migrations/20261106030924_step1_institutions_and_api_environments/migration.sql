-- CreateEnum
CREATE TYPE "InstitutionStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ApiEnvironmentKind" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "ApiEnvironmentStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "Bank" ADD COLUMN     "institutionId" TEXT;

-- CreateTable
CREATE TABLE "Institution" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "InstitutionStatus" NOT NULL DEFAULT 'PENDING',
    "contactEmail" TEXT,
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiEnvironment" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "kind" "ApiEnvironmentKind" NOT NULL,
    "status" "ApiEnvironmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "webhookUrl" TEXT,
    "webhookSecretHash" TEXT,
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Institution_slug_key" ON "Institution"("slug");

-- CreateIndex
CREATE INDEX "Institution_status_idx" ON "Institution"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ApiEnvironment_institutionId_kind_key" ON "ApiEnvironment"("institutionId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_prefix_key" ON "ApiCredential"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_keyHash_key" ON "ApiCredential"("keyHash");

-- CreateIndex
CREATE INDEX "ApiCredential_environmentId_idx" ON "ApiCredential"("environmentId");

-- CreateIndex
CREATE INDEX "Bank_institutionId_idx" ON "Bank"("institutionId");

-- AddForeignKey
ALTER TABLE "Bank" ADD CONSTRAINT "Bank_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiEnvironment" ADD CONSTRAINT "ApiEnvironment_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "ApiEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
