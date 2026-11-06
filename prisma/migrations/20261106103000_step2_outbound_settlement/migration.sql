-- CreateEnum
CREATE TYPE "CounterpartyStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SettlementTransferStatus" AS ENUM ('AWAITING_APPROVAL', 'APPROVED', 'SUBMITTED', 'CONFIRMED', 'SETTLED', 'FAILED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" "CounterpartyStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "custodyWhitelisted" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementTransfer" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "reference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "SettlementTransferStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "policy" JSONB,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "journalEntryId" TEXT,
    "providerTxId" TEXT,
    "txHash" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Counterparty_institutionId_environmentId_status_idx" ON "Counterparty"("institutionId", "environmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Counterparty_environmentId_address_key" ON "Counterparty"("environmentId", "address");

-- CreateIndex
CREATE INDEX "SettlementTransfer_institutionId_environmentId_status_idx" ON "SettlementTransfer"("institutionId", "environmentId", "status");

-- CreateIndex
CREATE INDEX "SettlementTransfer_status_nextAttemptAt_idx" ON "SettlementTransfer"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SettlementTransfer_providerTxId_idx" ON "SettlementTransfer"("providerTxId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementTransfer_environmentId_idempotencyKey_key" ON "SettlementTransfer"("environmentId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Counterparty" ADD CONSTRAINT "Counterparty_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Counterparty" ADD CONSTRAINT "Counterparty_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "ApiEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementTransfer" ADD CONSTRAINT "SettlementTransfer_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementTransfer" ADD CONSTRAINT "SettlementTransfer_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "ApiEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementTransfer" ADD CONSTRAINT "SettlementTransfer_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementTransfer" ADD CONSTRAINT "SettlementTransfer_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

