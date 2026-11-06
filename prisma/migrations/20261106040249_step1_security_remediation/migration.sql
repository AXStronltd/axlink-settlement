-- AlterTable
ALTER TABLE "BankDeposit" ADD COLUMN     "settlementAssetId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "institutionId" TEXT;

-- CreateTable
CREATE TABLE "ProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "assetId" TEXT,
    "institutionId" TEXT,
    "vaultId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderEvent_entityType_entityId_idx" ON "ProviderEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ProviderEvent_institutionId_idx" ON "ProviderEvent"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEvent_provider_eventId_key" ON "ProviderEvent"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
