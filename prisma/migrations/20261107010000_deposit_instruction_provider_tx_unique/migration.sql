-- One custody transaction settles at most one deposit instruction (defence in depth for untracked receipts).
CREATE UNIQUE INDEX "DepositInstruction_providerTxId_key" ON "DepositInstruction"("providerTxId");
