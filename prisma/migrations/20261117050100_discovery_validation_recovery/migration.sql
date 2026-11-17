-- Add recovery ownership without rewriting audit receipts, candidates or Jobs.
CREATE TABLE "AtsDiscoveryValidationRecovery" (
  platform TEXT NOT NULL,
  "normalizedSlug" TEXT NOT NULL,
  slug TEXT NOT NULL,
  "sourceRunId" TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (platform, "normalizedSlug")
);
CREATE INDEX "AtsDiscoveryValidationRecovery_state_nextAttemptAt_idx"
  ON "AtsDiscoveryValidationRecovery" (state, "nextAttemptAt");
