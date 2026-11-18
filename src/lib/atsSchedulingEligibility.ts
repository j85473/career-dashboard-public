import type { Prisma } from './prismaClient';
import { NON_API_ATS_PLATFORMS } from './browserAtsBoards';
import { atsListingPauseWhere } from './atsListingPause';
import { atsRotationCohortWhere } from './atsRotationCohort';
import { apiRotationDayFor } from './atsRotation';

export const ATS_CONTINUATION_PHASES = ['listing', 'compaction', 'enrichment', 'sealing'] as const;
export const ATS_DRAIN_PHASES = ['compaction', 'enrichment', 'sealing'] as const;
export const ATS_OPEN_BATCH_STATUSES = ['fetching', 'partial', 'synchronized', 'reset_draining'] as const;
export const ATS_API_SERVICE_CLASSES = ['first', 'current', 'overdue', 'recovery'] as const;
export type AtsApiServiceClass = typeof ATS_API_SERVICE_CLASSES[number];

export function atsCoverageEligibilityWhere(now: Date, paused: readonly string[], firstCollection: Prisma.AtsCompanyWhereInput,
  cohortOnly = false): Prisma.AtsCompanyWhereInput {
  return {
    acquisitionEngine: 'v2', status: { in: ['active', 'parked', 'blacklisted'] }, nextCheckDate: { lte: now },
    firstCollectionHoldReason: null,
    platform: { notIn: [...NON_API_ATS_PLATFORMS, ...paused] },
    AND: [firstCollection, ...(cohortOnly ? [{ status: 'active' }, atsRotationCohortWhere(apiRotationDayFor(now))] : [])],
    ingestionBatches: { none: { status: { in: [...ATS_OPEN_BATCH_STATUSES] } } },
  };
}

export function atsContinuationEligibilityWhere(now: Date, paused: readonly string[]): Prisma.AtsIngestionBatchWhereInput {
  return {
    writerMode: 'v2', platform: { notIn: NON_API_ATS_PLATFORMS },
    status: { in: [...ATS_OPEN_BATCH_STATUSES] }, acquisitionPhase: { in: [...ATS_CONTINUATION_PHASES] },
    OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: now } }],
    AND: [atsListingPauseWhere(paused), gr8PeopleListingBoardWhere(), { OR: [{ acquisitionClaimToken: null }, { acquisitionLeaseExpiresAt: { lte: now } }] }],
  };
}

/** An excluded GR8 People site cannot supply more pages. Its saved data can still be processed. */
export function gr8PeopleListingBoardWhere(): Prisma.AtsIngestionBatchWhereInput {
  return { NOT: { platform: 'gr8people', acquisitionPhase: 'listing', board: { status: 'excluded' } } };
}

const boardRecovery: Prisma.AtsCompanyWhereInput = { OR: [
  { status: { in: ['parked', 'blacklisted'] } }, { failCount: { gt: 0 } }, { retryCount: { gt: 0 } },
] };
export function atsCoverageServiceWhere(key: AtsApiServiceClass, now: Date): Prisma.AtsCompanyWhereInput {
  if (key === 'recovery') return boardRecovery;
  const first = { firstCollectionState: { in: ['ready', 'admitted'] } };
  return { AND: [{ status: 'active' }, { NOT: boardRecovery }, key === 'first' ? first : { NOT: first },
    ...(key === 'current' ? [atsRotationCohortWhere(apiRotationDayFor(now))]
      : key === 'overdue' ? [{ NOT: atsRotationCohortWhere(apiRotationDayFor(now)) }] : [])] };
}

export function atsContinuationRecoveryWhere(now: Date): Prisma.AtsIngestionBatchWhereInput {
  return { OR: [
    { board: { OR: [boardRecovery, { status: { not: 'active' } }] } }, { lastError: { not: null } },
    { acquisitionPhase: 'enrichment', items: {
      some: { enrichmentStatus: 'pending', detailAttemptCount: { gt: 0 } },
      none: { enrichmentStatus: 'pending', detailAttemptCount: 0,
        OR: [{ nextDetailAt: null }, { nextDetailAt: { lte: now } }] },
    } },
  ] };
}

export function atsContinuationServiceWhere(key: AtsApiServiceClass, now: Date): Prisma.AtsIngestionBatchWhereInput {
  const recovery = atsContinuationRecoveryWhere(now);
  if (key === 'recovery') return recovery;
  return { AND: [{ NOT: recovery }, { board: atsCoverageServiceWhere(key, now) }] };
}
