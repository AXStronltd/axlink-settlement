-- Institution portal users (people) and their sessions; API credentials stay for servers.
CREATE TABLE "PortalUser" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PortalUser_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PortalSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PortalSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PortalUser_email_key" ON "PortalUser"("email");
CREATE INDEX "PortalUser_institutionId_idx" ON "PortalUser"("institutionId");
CREATE UNIQUE INDEX "PortalSession_tokenHash_key" ON "PortalSession"("tokenHash");
CREATE INDEX "PortalSession_userId_idx" ON "PortalSession"("userId");
ALTER TABLE "PortalUser" ADD CONSTRAINT "PortalUser_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PortalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
