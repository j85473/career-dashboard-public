-- Route new GR8 People boards through the existing first-collection reservation.
CREATE OR REPLACE FUNCTION ats_first_collection_board_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.platform IN (
    'zohorecruit', 'gem', 'jobscore', 'jazzhr', 'manatal', 'clearcompany', 'hirehive', 'kula',
    'symphony', 'cornerstone', 'hireology', 'polymer', 'homerun', 'softgarden', 'dvinci', 'flatchr', 'gr8people'
  ) THEN
    NEW."firstCollectionState" := 'waiting';
    NEW."firstCollectionBatchId" := NULL;
    NEW."firstCollectionAdmittedAt" := NULL;
    NEW."firstCollectionCompletedAt" := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ats_first_collection_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE board_state TEXT; reserved_batch TEXT;
BEGIN
  IF NEW.platform NOT IN (
    'zohorecruit', 'gem', 'jobscore', 'jazzhr', 'manatal', 'clearcompany', 'hirehive', 'kula',
    'symphony', 'cornerstone', 'hireology', 'polymer', 'homerun', 'softgarden', 'dvinci', 'flatchr', 'gr8people'
  ) THEN RETURN NEW; END IF;
  SELECT "firstCollectionState", "firstCollectionBatchId" INTO board_state, reserved_batch
    FROM "AtsCompany" WHERE slug=NEW.slug AND platform=NEW.platform FOR SHARE;
  IF board_state = 'established' THEN RETURN NEW; END IF;
  IF board_state = 'admitted' AND reserved_batch = NEW.id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ATS first collection requires a durable admission reservation' USING ERRCODE='23514';
END $$;

-- Seed the verified board independently of historical discovery coverage.
INSERT INTO "AtsFirstCollectionCandidate" (slug, platform, "sourceUrl") VALUES
  ('careers.teradata.com', 'gr8people', 'https://careers.teradata.com/jobs')
ON CONFLICT (slug, platform) DO NOTHING;
