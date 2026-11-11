/** Explicit, serial four-provider launch. Preview by default; preserves both queue limits. */
import { prisma } from '../src/lib/prisma';
import { recordDiscoveredAtsBoard } from '../src/lib/atsBoardDiscovery';
import { FIRST_COLLECTION_POLICY_ID, firstCollectionHealth } from '../src/lib/atsFirstCollectionAdmission';
import { REVIEWED_FIRST_COLLECTION_POLICY_ID, REVIEWED_PROVIDER_LAUNCH_BOARDS,
  reviewedFirstCollectionBoards } from '../src/lib/atsReviewedFirstCollection';
import { validateSlug } from '../src/scripts/discoverATS';

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Usage: release_ats_provider_launches.ts [--apply]');
  const apply = process.argv.includes('--apply');
  const policy = await prisma.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: FIRST_COLLECTION_POLICY_ID } });
  if (policy.mode !== 'capacity') throw Error('Ordinary operator mode must remain capacity');
  const validated: Array<{ platform: typeof REVIEWED_PROVIDER_LAUNCH_BOARDS[number]['platform']; slug: string; jobsFound: number }> = [];
  for (const board of REVIEWED_PROVIDER_LAUNCH_BOARDS) {
    const result = await validateSlug(board.platform, board.slug, policy.maxResponseBytes);
    if (!result.success || result.sizeReview || !Number.isSafeInteger(result.jobsFound)
      || result.jobsFound < 0 || result.jobsFound > Math.min(250, policy.maxCatalogueJobs)) {
      throw Error(`${board.platform} launch did not pass the ordinary catalogue limit`);
    }
    validated.push({ ...board, jobsFound: result.jobsFound });
  }
  if (!apply) { console.log(JSON.stringify({ apply, serial: true, maximumJobs: 250, validated })); return; }
  const now = new Date();
  const released = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id=${FIRST_COLLECTION_POLICY_ID} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id=${REVIEWED_FIRST_COLLECTION_POLICY_ID} FOR UPDATE`;
    const ordinary = await tx.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: FIRST_COLLECTION_POLICY_ID } });
    const reviewed = await tx.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: REVIEWED_FIRST_COLLECTION_POLICY_ID } });
    const existing = reviewedFirstCollectionBoards(reviewed);
    if (ordinary.mode !== 'capacity' || reviewed.mode !== 'capacity' || !existing.length
      || ordinary.maxCatalogueJobs !== policy.maxCatalogueJobs || ordinary.maxResponseBytes !== policy.maxResponseBytes
      || reviewed.maxResponseBytes !== policy.maxResponseBytes) throw Error('Operator policy changed or reviewed serial queue is unavailable');
    if (ordinary.validationLeaseExpiresAt && ordinary.validationLeaseExpiresAt > now) throw Error('An existing validator still owns its candidate');
    if (!(await firstCollectionHealth(tx, 250, policy.maxResponseBytes, now, 'high')).healthy) throw Error('Existing volume limits do not permit the reviewed launch');
    const allowed = new Set(existing.map(board => `${board.platform}::${board.slug}`));
    const results = [];
    for (const board of validated) {
      const identity = { platform: board.platform, slug: board.slug };
      const candidate = await tx.atsFirstCollectionCandidate.findUniqueOrThrow({ where: { slug_platform: identity } });
      const current = await tx.atsCompany.findUnique({ where: { slug_platform: identity } });
      if (current && (current.status !== 'active' || current.firstCollectionHoldReason
        || current.firstCollectionState !== 'waiting' || current.firstCollectionBatchId
        || current.lastAttemptedAt || current.lastRespondedAt || current.lastSynchronizedAt || current.lastProcessedAt)) {
        results.push({ ...identity, outcome: 'existing_work_preserved' }); continue;
      }
      if (candidate.state !== 'discovered' || candidate.lastValidationStartedAt || candidate.lastError || candidate.nextValidationAt > now) {
        results.push({ ...identity, outcome: 'existing_validation_preserved' }); continue;
      }
      const outcome = await recordDiscoveredAtsBoard(tx, identity, now, { jobsFound: board.jobsFound, reactivateExisting: false });
      if (outcome === 'retired') { results.push({ ...identity, outcome: 'retirement_preserved' }); continue; }
      await tx.atsCompany.update({ where: { slug_platform: identity }, data: {
        firstCollectionState: 'ready', jobsFound: board.jobsFound, nextCheckDate: now,
      } });
      await tx.atsFirstCollectionCandidate.update({ where: { slug_platform: identity }, data: {
        state: 'validated', estimatedJobs: board.jobsFound, validatedAt: now, lastValidationStartedAt: now,
      } });
      allowed.add(`${board.platform}::${board.slug}`);
      results.push({ ...board, outcome: 'released_serially' });
    }
    if (allowed.size > 100) throw Error('Reviewed identity limit would be exceeded');
    await tx.atsFirstCollectionPolicy.update({ where: { id: reviewed.id }, data: { pilotBoards: [...allowed] } });
    return results;
  }, { timeout: 30_000 });
  console.log(JSON.stringify({ apply, serial: true, maximumJobs: 250, ordinaryLimitUnchanged: true, released }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
