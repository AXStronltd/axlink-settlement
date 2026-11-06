-- AlterEnum
ALTER TYPE "DepositInstructionStatus" ADD VALUE 'RECEIVED';

-- AlterTable
ALTER TABLE "DepositInstruction" ADD COLUMN     "lastReceiptAt" TIMESTAMP(3),
ADD COLUMN     "lastReceiptError" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMP(3);
