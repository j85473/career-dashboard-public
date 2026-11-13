ALTER TABLE "JobInterview" ADD COLUMN "endsAt" TIMESTAMP(3);
ALTER TABLE "JobInterview" ADD CONSTRAINT "JobInterview_end_after_start"
  CHECK ("endsAt" IS NULL OR "endsAt" > "scheduledAt");
