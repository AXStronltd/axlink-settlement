-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterTable
ALTER TABLE "Counterparty" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'EXTERNAL',
ADD COLUMN     "participantInstitutionId" TEXT;

-- AlterTable
ALTER TABLE "SettlementTransfer" ADD COLUMN     "creditEntryId" TEXT,
ADD COLUMN     "receivingWalletId" TEXT;

-- CreateTable
CREATE TABLE "OperationalException" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "currency" TEXT,
    "expected" DECIMAL(28,10),
    "actual" DECIMAL(28,10),
    "detail" JSONB,
    "institutionId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "lastRunId" TEXT,

    CONSTRAINT "OperationalException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationalException_status_severity_lastSeenAt_idx" ON "OperationalException"("status", "severity", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OperationalException_institutionId_status_idx" ON "OperationalException"("institutionId", "status");

-- CreateIndex
CREATE INDEX "OperationalException_kind_subject_currency_status_idx" ON "OperationalException"("kind", "subject", "currency", "status");

-- One OPEN/ACKNOWLEDGED item per (kind, subject, currency); resolved history may repeat. NULL currency is coalesced so it participates.
CREATE UNIQUE INDEX "OperationalException_open_one_per_subject" ON "OperationalException"("kind", "subject", (COALESCE("currency", ''))) WHERE "status" IN ('OPEN', 'ACKNOWLEDGED');

