import { ATS_JOB_ENRICHMENT_VERSION, readAtsJobEnrichmentMarker } from './atsJobEnrichment';
import type { AtsPostingEmployerEvidence } from './atsEmployerRecovery';
import { atsLedgerHash } from './atsEvidenceHash';
import { atsListingSourceId } from './atsPrequeueCompaction';
import { resolveAtsItemRaw } from './atsRawEvidence';
import { postingMetadataValue } from './postingMetadata';
import { prisma } from './prisma';
import { publicAtsBoardSlugFromUrl } from './publicAtsBoards';
import { publishedEmployerName } from './publicAtsEmployer';

type EvidenceItem = Parameters<typeof resolveAtsItemRaw>[0] & { enrichmentOverlay: unknown };
const MAX_COPIES = 32;

/** Reuse employer proof only from a more recent, exact copy on the same board.
 * The older posting keeps its own title, description, and immutable manifest. */
export async function readNewerAtsPostingEmployerEvidence(platform: string, slug: string, olderBatchId: string,
  job: Record<string, unknown>, client: Pick<typeof prisma, '$queryRaw'> = prisma): Promise<AtsPostingEmployerEvidence | null> {
  if (platform !== 'oracle' && platform !== 'ukg') return null;
  const sourceId = atsListingSourceId(platform, job);
  if (!sourceId || typeof job.publicAtsPostingId !== 'string' || !job.publicAtsPostingId
    || typeof job.title !== 'string' || !job.title.trim() || typeof job.url !== 'string'
    || publicAtsBoardSlugFromUrl(job.url, platform) !== slug) return null;

  const copies = await client.$queryRaw<EvidenceItem[]>`
    SELECT item.id, item."batchId", item."rawHash", item."rawJson", item."rawReference",
      item."representativeObservationId", item."enrichmentOverlay",
      CASE WHEN observation.id IS NOT NULL THEN jsonb_build_object(
        'id', observation.id, 'batchId', observation."batchId",
        'rawHash', observation."rawHash", 'rawJson', observation."rawJson"
      ) END AS "representativeObservation"
    FROM "AtsIngestionBatch" older
    JOIN "AtsIngestionBatch" newer ON newer.platform = older.platform AND newer.slug = older.slug
      AND newer."createdAt" > older."createdAt"
    JOIN "AtsIngestionItem" item ON item."batchId" = newer.id
      AND item."ledgerGeneration" = newer."activeLedgerGeneration" AND item."providerSourceId" = ${sourceId}
    LEFT JOIN "AtsListingObservation" observation ON observation.id = item."representativeObservationId"
    WHERE older.id = ${olderBatchId} AND older.platform = ${platform} AND older.slug = ${slug}
      AND older."writerMode" = 'v2' AND older."operatorResetAt" IS NULL
      AND newer."writerMode" = 'v2' AND newer."operatorResetAt" IS NULL
      AND newer."createdAt" >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '14 days'
      AND item."enrichmentStatus" = 'terminal' AND item."enrichmentVersion" = ${ATS_JOB_ENRICHMENT_VERSION}
      AND item."enrichmentOverlay"->'__careerDashboardAtsEnrichment'->>'status' = 'enriched'
    LIMIT ${MAX_COPIES + 1}
  `;
  if (copies.length > MAX_COPIES) return null;

  const companies = new Set<string>();
  const locations = new Set<string>();
  for (const copy of copies) {
    const marker = readAtsJobEnrichmentMarker(copy.enrichmentOverlay);
    if (marker?.platform !== platform || marker.status !== 'enriched') continue;
    const company = marker.company === 'Oracle' && platform === 'oracle' && slug.startsWith('eeho.fa.us2.oraclecloud.com::')
      ? 'Oracle' : publishedEmployerName(marker.company);
    if (!company) continue;
    let raw: Record<string, unknown>;
    try {
      raw = resolveAtsItemRaw(copy);
    } catch {
      return null;
    }
    if (raw.publicAtsPostingId !== job.publicAtsPostingId || raw.title !== job.title || raw.url !== job.url) continue;
    if (atsLedgerHash(raw) !== copy.rawHash) return null;
    companies.add(company);
    const location = postingMetadataValue(marker.location);
    if (location) locations.add(location);
  }
  if (companies.size !== 1) return null;
  return { company: [...companies][0], description: null, location: locations.size === 1 ? [...locations][0] : null };
}
