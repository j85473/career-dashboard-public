-- Saved employer posting ownership only considers ATS observations.
-- Keep the indexed key bounded and compare the full URL in the lookup.
CREATE INDEX "JobSourceObservation_ats_url_lookup_idx"
  ON "JobSourceObservation" (left(url, 512) COLLATE "C")
  WHERE source LIKE 'ATS-%';

ANALYZE "JobSourceObservation";
