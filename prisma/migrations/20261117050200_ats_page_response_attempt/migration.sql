-- Coordinated writer upgrade, not an expand-only rollout: stop every old
-- acquisition worker before replacing the offset-only unique key. Existing
-- pages, observations, hashes, cursors and retry dates remain unchanged.
BEGIN;

-- A rollback binary with writer version 3 must refuse acquisition rather than
-- interpret an offset containing multiple immutable responses. Inactive systems
-- are not activated by this migration. The web app and existing Job data remain.
UPDATE "AtsAcquisitionRuntimeGate"
  SET "minimumWriterVersion" = GREATEST("minimumWriterVersion", 4),
      "compatibilityWriterVersion" = GREATEST("compatibilityWriterVersion", 4)
  WHERE id = 'global' AND "v2AuthorityActivatedAt" IS NOT NULL;

ALTER TABLE "AtsIngestionPage"
  ADD COLUMN "responseAttempt" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "AtsIngestionPage_response_attempt_nonnegative" CHECK ("responseAttempt" >= 0);

CREATE UNIQUE INDEX "AtsIngestionPage_response_attempt_key"
  ON "AtsIngestionPage" ("batchId", "generation", "requestedOffset", "responseAttempt");
DROP INDEX "AtsIngestionPage_batchId_generation_requestedOffset_key";

-- The original immutable-evidence trigger remains authoritative for every
-- existing field. This companion protects the new append dimension and permits
-- another response only when the previous response could not advance at all.
CREATE FUNCTION "guard_ats_page_response_attempt"()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  prior "AtsIngestionPage"%ROWTYPE;
  batch "AtsIngestionBatch"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."responseAttempt" IS DISTINCT FROM OLD."responseAttempt" THEN
      RAISE EXCEPTION 'ATS page response attempts are immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."responseAttempt" = 0 THEN RETURN NEW; END IF;
  SELECT * INTO batch FROM "AtsIngestionBatch" WHERE id = NEW."batchId" FOR UPDATE;
  SELECT * INTO prior FROM "AtsIngestionPage"
    WHERE "batchId" = NEW."batchId" AND generation = NEW.generation
      AND "requestedOffset" = NEW."requestedOffset"
    ORDER BY "responseAttempt" DESC LIMIT 1;
  IF prior.id IS NULL OR NEW."responseAttempt" <> prior."responseAttempt" + 1
    OR prior."responseItemCount" <> 0 OR prior."materializationCompleteAt" IS NULL
    OR batch.platform = 'oracle'
    OR NOT (CASE WHEN jsonb_typeof(prior.metadata->'listingHasMore') = 'boolean'
      THEN (prior.metadata->>'listingHasMore')::boolean
      ELSE COALESCE(prior."providerTotal" > prior."requestedOffset", false) END)
    OR batch."writerMode" <> 'v2' OR batch."acquisitionPhase" <> 'listing'
    OR batch."activeLedgerGeneration" <> NEW.generation OR batch."listingGeneration" <> NEW.generation
    OR batch."listingOffset" <> NEW."requestedOffset"
    OR batch."acquisitionClaimToken" IS NULL
    OR batch."acquisitionLeaseExpiresAt" IS NULL
    OR batch."acquisitionLeaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'ATS page response attempt requires a live unchanged cursor after an incomplete empty response';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "guard_ats_page_response_attempt"
  BEFORE INSERT OR UPDATE ON "AtsIngestionPage"
  FOR EACH ROW EXECUTE FUNCTION "guard_ats_page_response_attempt"();

COMMIT;
