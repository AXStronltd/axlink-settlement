-- Add Fireblocks Network connection ID to Bank (bilateral channel reference)
ALTER TABLE "Bank" ADD COLUMN IF NOT EXISTS "fbNetworkConnId" TEXT;
