-- AlterEnum
ALTER TYPE "SettlementTransferStatus" ADD VALUE 'SUBMITTING';

-- DropIndex
DROP INDEX "SettlementTransfer_providerTxId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "SettlementTransfer_providerTxId_key" ON "SettlementTransfer"("providerTxId");

-- CreateIndex
CREATE INDEX "SettlementTransfer_walletId_assetId_status_idx" ON "SettlementTransfer"("walletId", "assetId", "status");

