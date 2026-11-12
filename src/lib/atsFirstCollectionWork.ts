import { Prisma } from './prismaClient';
import { atsRunnableSegmentSql } from './atsAdmissionCapacity';
import { atsEmployerVerificationHoldSql } from './atsEmployerRetry';

/** Retry-only enrichment is retained recovery work, not a fresh collection
 * reservation. A live worker or unfinished publication/persistence still owns
 * capacity. SQL aliases are board, batch and segment at the admission boundary. */
export function firstCollectionProductiveWorkSql(now: Date): Prisma.Sql {
  const instant = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  return Prisma.sql`(batch.id IS NULL
    OR batch."processingErrorCount" > 0
    OR (batch."acquisitionClaimToken" IS NOT NULL AND batch."acquisitionLeaseExpiresAt" > ${instant})
    OR (batch.status IN ('fetching','partial') AND board."firstCollectionHoldReason" IS NULL
      AND (batch."nextAcquireAt" IS NULL OR batch."nextAcquireAt" <= ${instant})
      AND ((batch."acquisitionPhase" IN ('listing','compaction','sealing') AND batch."lastError" IS NULL)
        OR (batch."acquisitionPhase"='enrichment' AND EXISTS (
          SELECT 1 FROM "AtsIngestionItem" fresh
          WHERE fresh."batchId"=batch.id AND fresh."ledgerGeneration"=batch."activeLedgerGeneration"
            AND fresh."enrichmentStatus"='pending' AND fresh."detailAttemptCount"=0
            AND (fresh."nextDetailAt" IS NULL OR fresh."nextDetailAt" <= ${instant})))))
    OR (batch.status='synchronized' AND batch."publishedItemCount" < batch."terminalItemCount")
    OR EXISTS (SELECT 1 FROM "AtsIngestionSegment" segment WHERE segment."batchId"=batch.id
      AND (segment.status='sealed' OR (${atsRunnableSegmentSql(now)}
        AND NOT (segment.status='published' AND ${atsEmployerVerificationHoldSql()})))))`;
}
