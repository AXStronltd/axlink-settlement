-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- AlterTable
ALTER TABLE "ProviderEvent" ADD COLUMN     "walletId" TEXT;

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "custodyProvider" TEXT NOT NULL DEFAULT 'fireblocks',
    "custodyVaultId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "depositAddress" TEXT,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "legacyUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletBalance" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "available" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "pending" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_legacyUserId_key" ON "Wallet"("legacyUserId");

-- CreateIndex
CREATE INDEX "Wallet_institutionId_idx" ON "Wallet"("institutionId");

-- CreateIndex
CREATE INDEX "Wallet_environmentId_idx" ON "Wallet"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_custodyProvider_custodyVaultId_key" ON "Wallet"("custodyProvider", "custodyVaultId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletBalance_walletId_assetId_key" ON "WalletBalance"("walletId", "assetId");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "ApiEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletBalance" ADD CONSTRAINT "WalletBalance_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
