-- AlterTable
ALTER TABLE "ApiEnvironment" ADD COLUMN     "settlementWalletId" TEXT,
ADD COLUMN     "transferDailyLimit" DECIMAL(36,18),
ADD COLUMN     "transferMaxAmount" DECIMAL(36,18),
ADD COLUMN     "transferMaxPerHour" INTEGER;

-- AlterTable
ALTER TABLE "Counterparty" ADD COLUMN     "screening" JSONB;

