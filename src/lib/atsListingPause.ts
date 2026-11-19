import type { Prisma } from './prismaClient';
import { prisma } from './prisma';
import { pausedAtsPlatforms } from './atsProviderRequest';
import { effectiveProviderCircuitState } from './ingestionControl';

/** A cooldown is a request hold, never a reason to withhold acquired data. */
export async function readAtsListingPauses(now = new Date(), client: Pick<Prisma.TransactionClient, 'providerCircuit'> = prisma) {
  return client.providerCircuit.findMany({
    where: { provider: { startsWith: 'ATS-' }, state: 'open', openUntil: { gt: now } },
    select: { provider: true, openUntil: true, state: true, lastError: true },
  });
}

export function pausedAtsListingPlatforms(
  circuits: Awaited<ReturnType<typeof readAtsListingPauses>>,
  now = new Date(),
): string[] {
  return [...new Set([
    ...pausedAtsPlatforms(now.getTime()),
    ...circuits.filter(c => effectiveProviderCircuitState(c) === 'open'
      && c.openUntil && c.openUntil > now).map(c => c.provider.slice(4)),
  ])];
}

/** Apply inside AND so the existing retry and lease guards remain intact. */
export function atsListingPauseWhere(pausedPlatforms: readonly string[]): Prisma.AtsIngestionBatchWhereInput {
  if (pausedPlatforms.length === 0) return {};
  return { OR: [
    { platform: { notIn: [...pausedPlatforms] } },
    { acquisitionPhase: { not: 'listing' } },
    // Empty listing batches need no historical page, observation or item reads.
    { acquisitionBytes: { gt: 0 }, pages: { some: { materializationCompleteAt: null } } },
    { rawObservationCount: { gt: 0 }, observations: { some: { resolution: null } } },
    { canonicalOccurrenceCount: { gt: 0 }, items: { some: { enrichmentStatus: 'pending', enrichmentReason: null } } },
    { terminalItemCount: { gt: prisma.atsIngestionBatch.fields.sealedItemCount } },
  ] };
}
