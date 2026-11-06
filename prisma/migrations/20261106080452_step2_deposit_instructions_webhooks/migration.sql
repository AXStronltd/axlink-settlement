-- CreateEnum
CREATE TYPE "DepositInstructionStatus" AS ENUM ('PENDING', 'SETTLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "DepositInstruction" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "expectedAmount" DECIMAL(36,18) NOT NULL,
    "reference" TEXT,
    "trackingId" TEXT NOT NULL,
    "status" "DepositInstructionStatus" NOT NULL DEFAULT 'PENDING',
    "providerTxId" TEXT,
    "txHash" TEXT,
    "receivedAmount" DECIMAL(36,18),
    "settledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY['*']::TEXT[],
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepositInstruction_trackingId_key" ON "DepositInstruction"("trackingId");

-- CreateIndex
CREATE INDEX "DepositInstruction_institutionId_environmentId_status_idx" ON "DepositInstruction"("institutionId", "environmentId", "status");

-- CreateIndex
CREATE INDEX "DepositInstruction_walletId_idx" ON "DepositInstruction"("walletId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_institutionId_environmentId_status_idx" ON "WebhookEndpoint"("institutionId", "environmentId", "status");

-- AddForeignKey
ALTER TABLE "DepositInstruction" ADD CONSTRAINT "DepositInstruction_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositInstruction" ADD CONSTRAINT "DepositInstruction_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "ApiEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositInstruction" ADD CONSTRAINT "DepositInstruction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "ApiEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
