-- Manual link edits and ATS reconciliation look for literal, case-insensitive
-- URL prefixes on older jobs that may lack a posting identity. Byte-ordered
-- B-tree ranges can find these without scanning the two trigram indexes.
-- Bound index keys to 512 characters so URLs with long query strings fit.
-- The application still checks the complete prefix and requisition identity.
CREATE INDEX "Job_canonicalUrl_reconciliation_prefix_idx"
  ON "Job" (left(lower("canonicalUrl"), 512) COLLATE "C");

CREATE INDEX "Job_url_reconciliation_prefix_idx"
  ON "Job" (left(lower(url), 512) COLLATE "C");

ANALYZE "Job";
