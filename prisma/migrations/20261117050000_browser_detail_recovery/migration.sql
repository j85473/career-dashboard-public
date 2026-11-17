-- Add independent posting recovery without rewriting saved crawls, jobs or dates.
CREATE TABLE "AtsBrowserDetailRetry" (
  "slug" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "postingId" TEXT NOT NULL,
  "posting" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 1,
  "nextRetryAt" TIMESTAMP(3) NOT NULL,
  "lastError" TEXT NOT NULL,
  "firstFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AtsBrowserDetailRetry_pkey" PRIMARY KEY ("slug", "platform", "postingId"),
  CONSTRAINT "AtsBrowserDetailRetry_slug_platform_fkey" FOREIGN KEY ("slug", "platform") REFERENCES "AtsCompany"("slug", "platform") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AtsBrowserDetailRetry_status_check" CHECK ("status" IN ('pending', 'recovered', 'closed', 'already_observed')),
  CONSTRAINT "AtsBrowserDetailRetry_attempt_check" CHECK ("attemptCount" >= 1)
);
CREATE INDEX "AtsBrowserDetailRetry_platform_status_nextRetryAt_idx" ON "AtsBrowserDetailRetry"("platform", "status", "nextRetryAt");
CREATE INDEX "AtsBrowserDetailRetry_slug_platform_status_idx" ON "AtsBrowserDetailRetry"("slug", "platform", "status");
