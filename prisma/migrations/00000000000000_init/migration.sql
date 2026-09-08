-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kycStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "brainrockAccountId" TEXT,
    "virtualIban" TEXT,
    "virtualIbanBic" TEXT,
    "choiceBankAccountId" TEXT,
    "choiceBankAccountNumber" TEXT,
    "vaultId" TEXT NOT NULL,
    "usdtAddress" TEXT,
    "b2bWalletId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "balance" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "balanceUsd" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "fromAmount" DECIMAL(20,8) NOT NULL,
    "toAmount" DECIMAL(20,8) NOT NULL,
    "usdAmount" DECIMAL(20,8) NOT NULL,
    "usdtAmount" DECIMAL(20,8) NOT NULL,
    "fxRate" DECIMAL(20,8),
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "onrampId" TEXT,
    "offrampId" TEXT,
    "fbTxId" TEXT,
    "fbTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "usdAmount" DECIMAL(20,8) NOT NULL,
    "usdtAmount" DECIMAL(20,8) NOT NULL,
    "bankAccount" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "offrampId" TEXT,
    "fbTxId" TEXT,
    "brainrockPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankDeposit" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "usdAmount" DECIMAL(20,8) NOT NULL,
    "usdtAmount" DECIMAL(20,8) NOT NULL,
    "bankName" TEXT NOT NULL,
    "reference" TEXT,
    "method" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "onrampId" TEXT,
    "fbTxId" TEXT,
    "sessionId" TEXT,
    "checkoutUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CryptoBuy" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "fromAmount" DECIMAL(20,8) NOT NULL,
    "usdtAmount" DECIMAL(20,8) NOT NULL,
    "usdAmount" DECIMAL(20,8) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fbTxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CryptoBuy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "fromCurr" TEXT NOT NULL,
    "toCurr" TEXT NOT NULL,
    "rate" DECIMAL(20,8) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'b2binpay',
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Card" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerCardId" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "cardType" TEXT NOT NULL DEFAULT 'virtual',
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardAuthorization" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerAuthId" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "spendCurrency" TEXT NOT NULL,
    "debitAmount" DECIMAL(20,8) NOT NULL,
    "debitCurrency" TEXT NOT NULL,
    "fxRate" DECIMAL(20,8),
    "merchantName" TEXT,
    "merchantCategory" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bank" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "dailyLimitUsd" DECIMAL(20,2) NOT NULL DEFAULT 1000000,
    "corridorLimits" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankApiUsage" (
    "id" TEXT NOT NULL,
    "bankId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "settledUsd" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "txCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BankApiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterbankTransfer" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "bankReferenceId" TEXT NOT NULL,
    "senderBankId" TEXT NOT NULL,
    "senderCurrency" TEXT NOT NULL,
    "senderAmount" DECIMAL(20,8) NOT NULL,
    "receiverBankId" TEXT NOT NULL,
    "receiverCurrency" TEXT NOT NULL,
    "receiverAmount" DECIMAL(20,8) NOT NULL,
    "usdAmount" DECIMAL(20,8) NOT NULL,
    "usdtAmount" DECIMAL(20,8) NOT NULL,
    "fxRate" DECIMAL(20,8),
    "routeType" TEXT NOT NULL,
    "spread" DECIMAL(10,6) NOT NULL,
    "lpSource" TEXT,
    "fbTxId" TEXT,
    "solanaTxHash" TEXT,
    "senderName" TEXT,
    "senderAccount" TEXT,
    "receiverName" TEXT,
    "receiverAccount" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "webhookDelivered" BOOLEAN NOT NULL DEFAULT false,
    "webhookAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterbankTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "userId" TEXT,
    "bankId" TEXT,
    "transient" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "reversesId" TEXT,
    "postingKey" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedBy" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(28,10) NOT NULL,
    "currency" TEXT NOT NULL,
    "usdAmount" DECIMAL(28,10) NOT NULL,
    "memo" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_FLIGHT',
    "responseBody" JSONB,
    "entityType" TEXT,
    "entityId" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementLeg" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "externalKey" TEXT NOT NULL,
    "externalRef" TEXT,
    "asset" TEXT,
    "amount" DECIMAL(28,10),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SettlementLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementProof" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "slot" BIGINT NOT NULL,
    "blockTime" TIMESTAMP(3),
    "commitment" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "amount" DECIMAL(28,10) NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "feeLamports" BIGINT,
    "custodyTxId" TEXT,
    "onchainError" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "targetUrl" TEXT,
    "targetSecret" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "lastStatus" INTEGER,
    "entityType" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderAttempt" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "reference" TEXT,
    "currency" TEXT,
    "amount" DECIMAL(28,10),
    "fundingMode" TEXT,
    "settlementCurrency" TEXT,
    "outcome" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "quotedFeeUsd" DECIMAL(20,8),
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "asOf" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,
    "breakCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationBreak" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARN',
    "subject" TEXT NOT NULL,
    "currency" TEXT,
    "expected" DECIMAL(28,10),
    "actual" DECIMAL(28,10),
    "delta" DECIMAL(28,10),
    "detail" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationBreak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_vaultId_key" ON "User"("vaultId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_userId_currency_key" ON "Account"("userId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_trackingId_key" ON "Transfer"("trackingId");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_trackingId_key" ON "Withdrawal"("trackingId");

-- CreateIndex
CREATE UNIQUE INDEX "BankDeposit_trackingId_key" ON "BankDeposit"("trackingId");

-- CreateIndex
CREATE UNIQUE INDEX "BankDeposit_sessionId_key" ON "BankDeposit"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoBuy_trackingId_key" ON "CryptoBuy"("trackingId");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_fromCurr_toCurr_key" ON "ExchangeRate"("fromCurr", "toCurr");

-- CreateIndex
CREATE UNIQUE INDEX "Card_providerCardId_key" ON "Card"("providerCardId");

-- CreateIndex
CREATE UNIQUE INDEX "CardAuthorization_providerAuthId_key" ON "CardAuthorization"("providerAuthId");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_networkId_key" ON "Bank"("networkId");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_apiKeyHash_key" ON "Bank"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_vaultId_key" ON "Bank"("vaultId");

-- CreateIndex
CREATE UNIQUE INDEX "BankApiUsage_bankId_date_key" ON "BankApiUsage"("bankId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "InterbankTransfer_trackingId_key" ON "InterbankTransfer"("trackingId");

-- CreateIndex
CREATE INDEX "InterbankTransfer_senderBankId_createdAt_idx" ON "InterbankTransfer"("senderBankId", "createdAt");

-- CreateIndex
CREATE INDEX "InterbankTransfer_status_idx" ON "InterbankTransfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "InterbankTransfer_senderBankId_bankReferenceId_key" ON "InterbankTransfer"("senderBankId", "bankReferenceId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_code_key" ON "LedgerAccount"("code");

-- CreateIndex
CREATE INDEX "LedgerAccount_type_currency_idx" ON "LedgerAccount"("type", "currency");

-- CreateIndex
CREATE INDEX "LedgerAccount_userId_idx" ON "LedgerAccount"("userId");

-- CreateIndex
CREATE INDEX "LedgerAccount_bankId_idx" ON "LedgerAccount"("bankId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_postingKey_key" ON "JournalEntry"("postingKey");

-- CreateIndex
CREATE INDEX "JournalEntry_entityType_entityId_idx" ON "JournalEntry"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "JournalEntry_eventType_postedAt_idx" ON "JournalEntry"("eventType", "postedAt");

-- CreateIndex
CREATE INDEX "JournalEntry_postedAt_idx" ON "JournalEntry"("postedAt");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_scope_key_key" ON "IdempotencyKey"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementLeg_externalKey_key" ON "SettlementLeg"("externalKey");

-- CreateIndex
CREATE INDEX "SettlementLeg_status_nextAttemptAt_idx" ON "SettlementLeg"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SettlementLeg_entityType_entityId_idx" ON "SettlementLeg"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementLeg_entityType_entityId_sequence_key" ON "SettlementLeg"("entityType", "entityId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementProof_signature_key" ON "SettlementProof"("signature");

-- CreateIndex
CREATE INDEX "SettlementProof_entityType_entityId_idx" ON "SettlementProof"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "SettlementProof_mint_verifiedAt_idx" ON "SettlementProof"("mint", "verifiedAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_entityType_entityId_idx" ON "OutboxEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ProviderAttempt_providerId_createdAt_idx" ON "ProviderAttempt"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderAttempt_entityType_entityId_idx" ON "ProviderAttempt"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ProviderAttempt_outcome_createdAt_idx" ON "ProviderAttempt"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationRun_kind_startedAt_idx" ON "ReconciliationRun"("kind", "startedAt");

-- CreateIndex
CREATE INDEX "ReconciliationBreak_runId_severity_idx" ON "ReconciliationBreak"("runId", "severity");

-- CreateIndex
CREATE INDEX "ReconciliationBreak_kind_resolvedAt_idx" ON "ReconciliationBreak"("kind", "resolvedAt");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankDeposit" ADD CONSTRAINT "BankDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoBuy" ADD CONSTRAINT "CryptoBuy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardAuthorization" ADD CONSTRAINT "CardAuthorization_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankApiUsage" ADD CONSTRAINT "BankApiUsage_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterbankTransfer" ADD CONSTRAINT "InterbankTransfer_senderBankId_fkey" FOREIGN KEY ("senderBankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationBreak" ADD CONSTRAINT "ReconciliationBreak_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
