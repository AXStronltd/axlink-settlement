-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "webhookEndpointId" TEXT;

-- CreateIndex
CREATE INDEX "OutboxEvent_webhookEndpointId_createdAt_idx" ON "OutboxEvent"("webhookEndpointId", "createdAt");

