import { Prisma } from './prismaClient';
import { NON_API_ATS_PLATFORMS } from './browserAtsBoards';

export type AtsRetainedInventory = {
  observedAt: string;
  boards: { total: number; withoutRecordedAttempt: number; retryDue: number; retryScheduled: number };
  downloads: { total: number; working: number; scheduledRetry: number; other: number };
};

/** Display-only partitions. These counts never decide eligibility or change saved work. */
export function atsRetainedInventorySql(now: Date): Prisma.Sql {
  const utc = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  return Prisma.sql`
    WITH boards AS (
      SELECT "nextCheckDate", ("lastAttemptedAt" IS NULL AND "lastRespondedAt" IS NULL
        AND "lastCheckedAt" IS NULL AND "lastSynchronizedAt" IS NULL AND "lastProcessedAt" IS NULL) AS unattempted
      FROM "AtsCompany" WHERE status IN ('parked','blacklisted') AND platform <> 'gusto'
    ), downloads AS (
      SELECT GREATEST("rawObservationCount"-"compactedOccurrenceCount"-"publishedItemCount",0) AS items,
        ("acquisitionClaimToken" IS NOT NULL AND "acquisitionLeaseExpiresAt">${utc}) IS TRUE AS working,
        ("nextAcquireAt">${utc}) IS TRUE AS held
      FROM "AtsIngestionBatch" WHERE "writerMode"='v2' AND status IN ('fetching','partial','synchronized')
        AND platform NOT IN (${Prisma.join(NON_API_ATS_PLATFORMS)})
    )
    SELECT
      (SELECT COUNT(*) FROM boards) AS "boardsTotal",
      (SELECT COUNT(*) FROM boards WHERE unattempted) AS "withoutRecordedAttempt",
      (SELECT COUNT(*) FROM boards WHERE NOT unattempted AND "nextCheckDate"<=${utc}) AS "retryDue",
      (SELECT COUNT(*) FROM boards WHERE NOT unattempted AND "nextCheckDate">${utc}) AS "retryScheduled",
      (SELECT COALESCE(SUM(items),0) FROM downloads) AS "downloadsTotal",
      (SELECT COALESCE(SUM(items),0) FROM downloads WHERE working) AS "downloadsWorking",
      (SELECT COALESCE(SUM(items),0) FROM downloads WHERE NOT working AND held) AS "downloadsScheduledRetry",
      (SELECT COALESCE(SUM(items),0) FROM downloads WHERE NOT working AND NOT held) AS "downloadsOther"
  `;
}

export async function readAtsRetainedInventory(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>, now = new Date(),
): Promise<AtsRetainedInventory> {
  const [row] = await client.$queryRaw<Array<Record<string, bigint | number>>>(atsRetainedInventorySql(now));
  if (!row) throw new Error('ATS retained inventory is unavailable.');
  const n = (key: string) => Number(row[key]);
  return {
    observedAt: now.toISOString(),
    boards: { total: n('boardsTotal'), withoutRecordedAttempt: n('withoutRecordedAttempt'),
      retryDue: n('retryDue'), retryScheduled: n('retryScheduled') },
    downloads: { total: n('downloadsTotal'), working: n('downloadsWorking'),
      scheduledRetry: n('downloadsScheduledRetry'), other: n('downloadsOther') },
  };
}
