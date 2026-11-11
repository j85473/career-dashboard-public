import { Prisma } from './prismaClient';
import { FIRST_COLLECTION_PLATFORMS } from './atsFirstCollectionAdmission';

/** Give each provider a validation turn before returning to a large older
 * discovery backlog. Existing retry dates and candidate order within a provider
 * remain authoritative. The controller owns capacity and the validation lease. */
export function firstCollectionCandidateQuery(now: Date): Prisma.Sql {
  return Prisma.sql`
    WITH platform_turns AS (
      SELECT platform, MAX("lastValidationStartedAt") AS last_started
      FROM "AtsFirstCollectionCandidate"
      GROUP BY platform
    )
    SELECT candidate.* FROM "AtsFirstCollectionCandidate" candidate
    JOIN platform_turns turns ON turns.platform=candidate.platform
    WHERE candidate.state='discovered'
      AND candidate.platform IN (${Prisma.join([...FIRST_COLLECTION_PLATFORMS])})
      AND candidate."nextValidationAt" <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    ORDER BY turns.last_started ASC NULLS FIRST, candidate."createdAt" ASC,
      candidate.platform ASC, candidate.slug ASC
    LIMIT 1
  `;
}
