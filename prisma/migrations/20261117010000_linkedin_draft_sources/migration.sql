-- Add provenance and copy reminders without modifying existing drafts or tracking decisions.
ALTER TABLE "LinkedInDraft" ADD COLUMN "copiedAt" TIMESTAMP(3), ADD COLUMN "source" JSONB;
ALTER TABLE "UsedArticle" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "UsedArticle" SET "updatedAt" = "createdAt";
