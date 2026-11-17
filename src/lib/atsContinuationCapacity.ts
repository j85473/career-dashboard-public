import { NON_API_ATS_PLATFORMS } from './browserAtsBoards';
import type { Prisma } from './prismaClient';
import { atsContinuationEligibilityWhere } from './atsSchedulingEligibility';
import { ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK, ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK, ATS_V2_MAX_UNFINISHED_LISTINGS } from './atsAcquisitionPressure';
import { atsListingAdmissionReservationSql } from './atsAdmissionCapacity';

export const ATS_PRESSURE_LISTING_CONCURRENCY = 1;
// One bounded coverage producer can run alongside a continuing listing while
// six of the eight shared slots remain available to downstream drain work.
export const ATS_COHORT_PRESSURE_LISTING_CONCURRENCY = 2;
export const ATS_LISTING_CAPACITY_LOCK = 'ats-listing-continuation-capacity-v1';

/**
 * Run inside the same transaction that claims the batch. The shared lock
 * serializes only listing admissions, across every host, so two workers cannot
 * both observe the last available producer slot and take it.
 */
export async function withAtsListingCapacity<T>(
  transaction: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw' | 'atsIngestionBatch'>,
  now: Date,
  maximumListingClaims: number,
  claim: () => Promise<T | null>,
  options: { existingListing?: boolean } = {},
): Promise<T | null> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ATS_LISTING_CAPACITY_LOCK}, 0))`;
  const drain = await transaction.atsIngestionBatch.findFirst({
    where: {
      AND: [atsContinuationEligibilityWhere(now, []), { acquisitionPhase: { in: ['compaction', 'enrichment', 'sealing'] } }],
    }, select: { id: true },
  });
  if (!drain) {
    const { Prisma } = await import('./prismaClient');
    const [volume] = await transaction.$queryRaw<Array<{ items: bigint; bytes: bigint; unfinished: bigint }>>(Prisma.sql`
      SELECT COALESCE(SUM(GREATEST("rawObservationCount"-"compactedOccurrenceCount"-"publishedItemCount",0)),0)::bigint AS items,
        COALESCE(SUM("acquisitionBytes"),0)::bigint AS bytes,
        COUNT(*) FILTER(WHERE ${atsListingAdmissionReservationSql(now)})::bigint AS unfinished
      FROM "AtsIngestionBatch" batch WHERE "writerMode"='v2'
        AND platform NOT IN (${Prisma.join(NON_API_ATS_PLATFORMS)})
        AND status IN ('fetching','partial','synchronized','reset_draining')`);
    // The unfinished-board allowance limits opening new collections, not
    // finishing saved ones. Existing listings may borrow otherwise idle worker
    // capacity below the volume thresholds; provider/worker leases still bind.
    // Held work remains charged, and new intake keeps its admission allowance.
    if (volume && Number(volume.items) < ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK / 2
      && volume.bytes < ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK / BigInt(2)
      && (options.existingListing || Number(volume.unfinished) < ATS_V2_MAX_UNFINISHED_LISTINGS)) return claim();
  }
  const liveListings = await transaction.atsIngestionBatch.count({
    where: {
      writerMode: 'v2', platform: { notIn: NON_API_ATS_PLATFORMS },
      status: { in: ['fetching', 'partial', 'synchronized', 'reset_draining'] },
      acquisitionPhase: 'listing', acquisitionClaimToken: { not: null },
      acquisitionLeaseExpiresAt: { gt: now },
    },
  });
  const limit = Number.isFinite(maximumListingClaims) ? Math.max(1, Math.floor(maximumListingClaims)) : 1;
  if (liveListings >= limit) return null;
  return claim();
}
