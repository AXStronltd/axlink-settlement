-- AlterEnum
ALTER TYPE "SettlementTransferStatus" ADD VALUE 'UNDER_REVIEW';

-- AlterTable
ALTER TABLE "SettlementTransfer" ADD COLUMN     "finality" TEXT;

