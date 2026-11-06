-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_legacyUserId_fkey" FOREIGN KEY ("legacyUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
