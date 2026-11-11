/** Explicit four-provider enrollment. Existing first-collection timer owns refill. */
import { prisma } from '../src/lib/prisma';
import { FIRST_COLLECTION_POLICY_ID, firstCollectionHealth } from '../src/lib/atsFirstCollectionAdmission';
import { REVIEWED_FIRST_COLLECTION_POLICY_ID, REVIEWED_PROVIDER_BACKLOG_PLATFORMS,
  reviewedFirstCollectionBoards, reviewedProviderBacklogPlatforms, reviewedFirstCollectionWhere } from '../src/lib/atsReviewedFirstCollection';

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Usage: control_ats_provider_backlog.ts [--apply]');
  const apply = process.argv.includes('--apply');
  if (apply) await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id=${FIRST_COLLECTION_POLICY_ID} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id=${REVIEWED_FIRST_COLLECTION_POLICY_ID} FOR UPDATE`;
    const ordinary = await tx.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: FIRST_COLLECTION_POLICY_ID } });
    const reviewed = await tx.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: REVIEWED_FIRST_COLLECTION_POLICY_ID } });
    if (ordinary.mode !== 'capacity' || reviewed.mode !== 'capacity' || !reviewedFirstCollectionBoards(reviewed).length
      || reviewed.maxResponseBytes !== ordinary.maxResponseBytes) throw Error('Existing operator mode, reviewed queue shape and response limits must permit enrollment');
    const allowed = new Set(reviewedFirstCollectionBoards(reviewed).map(board => `${board.platform}::${board.slug}`));
    for (const platform of REVIEWED_PROVIDER_BACKLOG_PLATFORMS) allowed.add(`${platform}::*`);
    if (allowed.size > 100) throw Error('Reviewed identity limit would be exceeded');
    await tx.atsFirstCollectionPolicy.update({ where: { id: reviewed.id }, data: { pilotBoards: [...allowed] } });
  });
  const reviewed = await prisma.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: REVIEWED_FIRST_COLLECTION_POLICY_ID } });
  const [candidates, boards, health] = await Promise.all([
    prisma.atsFirstCollectionCandidate.groupBy({ by: ['platform', 'state'],
      where: { platform: { in: [...REVIEWED_PROVIDER_BACKLOG_PLATFORMS] } }, _count: true }),
    prisma.atsCompany.findMany({ where: { OR: reviewedFirstCollectionWhere(reviewed), firstCollectionState: { in: ['ready', 'admitted'] } },
      select: { platform: true, slug: true, firstCollectionState: true, firstCollectionHoldReason: true } }),
    firstCollectionHealth(prisma, 250, reviewed.maxResponseBytes, new Date(), 'high'),
  ]);
  console.log(JSON.stringify({ apply, enabledProviders: reviewedProviderBacklogPlatforms(reviewed),
    proposedProviders: REVIEWED_PROVIDER_BACKLOG_PLATFORMS, serial: true, maximumCatalogueJobs: 250,
    candidates, unfinishedReviewedBoards: boards, health }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
