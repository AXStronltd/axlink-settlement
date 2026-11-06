-- CreateIndex: a label is unique per API environment (concurrent creates cannot mint two vaults)
CREATE UNIQUE INDEX "Wallet_environmentId_label_key" ON "Wallet"("environmentId", "label");
