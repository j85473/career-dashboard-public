import { Prisma } from './prismaClient';
import { atsEmployerVerificationHoldSql } from './atsEmployerRetry';
import { atsRotationCohortSql } from './atsRotationCohort';
import { apiRotationDayFor } from './atsRotation';
import { NON_API_ATS_PLATFORMS } from './browserAtsBoards';
import { ATS_OPEN_BATCH_STATUSES } from './atsSchedulingEligibility';

/** One completed download may keep its posting-level evidence retries while an
 * established board takes its next scheduled turn. A second unfinished batch,
 * a processing lease, or any ordinary outstanding work closes the exception.
 * scope is an additional predicate on board or batch, never a replacement. */
export function atsEvidenceRefreshBatchesSql(scope: Prisma.Sql = Prisma.sql`TRUE`) {
  return Prisma.sql`
    SELECT batch.id, board.slug, board.platform, board."checkDay", board."nextCheckDate", board."lastAttemptedAt"
    FROM "AtsIngestionBatch" batch
    JOIN "AtsCompany" board ON board.slug = batch.slug AND board.platform = batch.platform
    WHERE (${scope})
      AND board."acquisitionEngine" = 'v2' AND board.status = 'active'
      AND board."firstCollectionState" = 'established' AND board."firstCollectionHoldReason" IS NULL
      AND board."failCount" = 0 AND board."retryCount" = 0
      AND batch."writerMode" = 'v2' AND batch.status = 'synchronized' AND batch."acquisitionPhase" = 'synchronized'
      AND batch."listingCompletedAt" IS NOT NULL AND batch."synchronizedAt" IS NOT NULL
      AND batch."processedAt" IS NULL AND batch."operatorResetAt" IS NULL AND batch."acquisitionClaimToken" IS NULL
      AND batch."canonicalOccurrenceCount" > 0 AND batch."canonicalOccurrenceCount" = batch."terminalItemCount"
      AND batch."canonicalOccurrenceCount" = batch."sealedItemCount" AND batch."canonicalOccurrenceCount" = batch."publishedItemCount"
      AND NOT EXISTS (SELECT 1 FROM "AtsIngestionBatch" other
        WHERE other.slug = batch.slug AND other.platform = batch.platform AND other.id <> batch.id
          AND other.status IN (${Prisma.join([...ATS_OPEN_BATCH_STATUSES, 'queued', 'processing', 'reset_synchronized'])}))
      AND EXISTS (SELECT 1 FROM "AtsIngestionSegment" segment
        WHERE segment."batchId" = batch.id AND segment.status <> 'processed'
        HAVING COUNT(*) > 0 AND BOOL_AND(segment."ledgerGeneration" = batch."activeLedgerGeneration"
          AND segment.status = 'published' AND segment."leaseToken" IS NULL
          AND segment."processingOffset" < segment."itemCount"
          AND (segment."retryScope" IS NULL OR segment."retryScope" = 'posting')
          AND ${atsEmployerVerificationHoldSql()}))`;
}

function dueEvidenceRefreshSql(now: Date, paused: readonly string[], cohortOnly: boolean) {
  const utc = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  return atsEvidenceRefreshBatchesSql(Prisma.sql`board."nextCheckDate" <= ${utc}
    AND board.platform NOT IN (${Prisma.join([...NON_API_ATS_PLATFORMS, ...paused])})
    ${cohortOnly ? Prisma.sql`AND ${atsRotationCohortSql(apiRotationDayFor(now))}` : Prisma.empty}`);
}

/** The ordinary selector inspects the oldest 1,000 candidates per service
 * class before its size preference. Only those same oldest refreshes can make
 * its head. Count the full set before limiting the candidate list. */
export async function readEvidenceRefreshCandidates(client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  now: Date, paused: readonly string[], cohortOnly: boolean) {
  const rows = await client.$queryRaw<Array<{ id: string; total: number }>>(Prisma.sql`
    SELECT ranked.id, ranked.total FROM (
      SELECT board.id, (COUNT(*) OVER ())::int AS total, ROW_NUMBER() OVER (PARTITION BY ${atsRotationCohortSql(apiRotationDayFor(now))}
        ORDER BY board."nextCheckDate", board."lastAttemptedAt" NULLS FIRST, board.platform, board.slug) AS position
      FROM (${dueEvidenceRefreshSql(now, paused, cohortOnly)}) board
    ) ranked WHERE ranked.position <= 1000`);
  return { ids: rows.map(row => row.id), total: rows[0]?.total ?? 0 };
}
