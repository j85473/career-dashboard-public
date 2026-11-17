-- Expand-only scheduler metadata. No existing work, dates, or scores change.
CREATE TABLE "AtsSchedulerState" (
    "resource" TEXT NOT NULL PRIMARY KEY,
    "state" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "AtsPublicCapacityLease" (
    "resource" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "jobs" INTEGER NOT NULL CHECK ("jobs" > 0 AND "jobs" <= 50),
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "requestedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "AtsPublicCapacityLease_token_key" ON "AtsPublicCapacityLease"("token");
CREATE INDEX "AtsPublicCapacityLease_leaseExpiresAt_idx" ON "AtsPublicCapacityLease"("leaseExpiresAt");
