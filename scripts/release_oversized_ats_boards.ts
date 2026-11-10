/** Explicit operator release. Preview by default; never changes ordinary limits. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { recordDiscoveredAtsBoard } from '../src/lib/atsBoardDiscovery';
import { admittedClearCompanySlug } from '../src/lib/clearcompanyBoard';
import { FIRST_COLLECTION_POLICY_ID } from '../src/lib/atsFirstCollectionAdmission';
import { REVIEWED_FIRST_COLLECTION_POLICY_ID, REVIEWED_FIRST_COLLECTION_MAXIMUM_JOBS,
  reviewedFirstCollectionBoards } from '../src/lib/atsReviewedFirstCollection';
import { validateSlug, type PLATFORMS } from '../src/scripts/discoverATS';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const existing = await prisma.atsFirstCollectionPolicy.findUnique({ where: { id: REVIEWED_FIRST_COLLECTION_POLICY_ID } });
  if (existing) {
    const identities = reviewedFirstCollectionBoards(existing);
    const boards = identities.length ? await prisma.atsCompany.findMany({
      where: { OR: identities }, orderBy: [{ firstCollectionAdmittedAt: 'asc' }, { jobsFound: 'asc' }],
      select: { platform: true, slug: true, status: true, jobsFound: true, firstCollectionState: true,
        firstCollectionBatchId: true, firstCollectionAdmittedAt: true, firstCollectionCompletedAt: true, firstCollectionHoldReason: true },
    }) : [];
    console.log(JSON.stringify({ existingRelease: true, policy: existing, boards }, null, 2));
    return;
  }
  if (args.includes('--status')) { console.log(JSON.stringify({ existingRelease: false })); return; }
  const policy = await prisma.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: FIRST_COLLECTION_POLICY_ID } });
  if (policy.mode !== 'capacity') throw new Error('Ordinary first-collection policy must be in capacity mode; operator holds are preserved');
  const candidates = await prisma.atsFirstCollectionCandidate.findMany({
    where: { state: 'size_review', OR: [
      { platform: 'clearcompany' }, { platform: 'symphony', slug: { in: ['hgv', 'victoriassecret'] } },
    ] },
    orderBy: [{ estimatedJobs: 'asc' }, { platform: 'asc' }, { slug: 'asc' }],
  });
  const validated: Array<{ platform: string; candidateSlug: string; slug: string; jobsFound: number }> = [];
  const deferred: Array<{ platform: string; slug: string; reason: string }> = [];
  for (const candidate of candidates) {
    const result = await validateSlug(candidate.platform as keyof typeof PLATFORMS, candidate.slug, policy.maxResponseBytes);
    if (!result.success || result.sizeReview || !Number.isSafeInteger(result.jobsFound)
      || result.jobsFound < 0 || result.jobsFound > REVIEWED_FIRST_COLLECTION_MAXIMUM_JOBS) {
      deferred.push({ platform: candidate.platform, slug: candidate.slug, reason: result.reason || 'Catalogue still exceeds the reviewed allowance' });
      continue;
    }
    const slug = candidate.platform === 'clearcompany' ? admittedClearCompanySlug(candidate.slug, result.canonicalSlug) : candidate.slug;
    validated.push({ platform: candidate.platform, candidateSlug: candidate.slug, slug, jobsFound: result.jobsFound });
  }
  if (!apply) { console.log(JSON.stringify({ apply: false, maximumJobs: REVIEWED_FIRST_COLLECTION_MAXIMUM_JOBS, serial: true, validated, deferred }, null, 2)); return; }
  if (!validated.length) throw new Error('No held catalogues passed current validation');
  const now = new Date();
  const released = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id=${FIRST_COLLECTION_POLICY_ID} FOR UPDATE`;
    if ((await tx.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: FIRST_COLLECTION_POLICY_ID } })).mode !== 'capacity') throw new Error('Operator policy changed during validation');
    if (await tx.atsFirstCollectionPolicy.findUnique({ where: { id: REVIEWED_FIRST_COLLECTION_POLICY_ID } })) throw new Error('Another reviewed release already exists');
    const results = [];
    const allowed = new Set<string>();
    for (const board of validated) {
      const identity = { platform: board.platform, slug: board.slug };
      const candidate = await tx.atsFirstCollectionCandidate.findUniqueOrThrow({ where: { slug_platform: { platform: board.platform, slug: board.candidateSlug } } });
      if (candidate.state !== 'size_review') throw new Error('Candidate changed during validation');
      const outcome = await recordDiscoveredAtsBoard(tx, identity, now, { jobsFound: board.jobsFound, reactivateExisting: false });
      if (outcome === 'retired') { results.push({ ...board, outcome: 'retired_preserved' }); continue; }
      const current = await tx.atsCompany.findUniqueOrThrow({ where: { slug_platform: identity } });
      if (current.status !== 'active' || current.firstCollectionHoldReason
        || !['waiting', 'ready', 'established'].includes(current.firstCollectionState)) throw new Error('Existing board work or hold requires separate review');
      if (current.firstCollectionState !== 'established') {
        await tx.atsCompany.update({ where: { slug_platform: identity }, data: {
          firstCollectionState: 'ready', jobsFound: board.jobsFound, nextCheckDate: now,
        } });
        allowed.add(`${board.platform}::${board.slug}`);
      }
      await tx.atsFirstCollectionCandidate.update({ where: { slug_platform: { platform: board.platform, slug: board.candidateSlug } }, data: {
        state: 'validated', estimatedJobs: board.jobsFound, validatedAt: now, lastError: null,
      } });
      results.push({ ...board, outcome: current.firstCollectionState === 'established' ? 'existing_collection_preserved' : 'released' });
    }
    if (allowed.size) await tx.atsFirstCollectionPolicy.create({ data: {
      id: REVIEWED_FIRST_COLLECTION_POLICY_ID, mode: 'capacity', dailyBoardLimit: 0, maxUnfinished: 1,
      maxCatalogueJobs: REVIEWED_FIRST_COLLECTION_MAXIMUM_JOBS, maxResponseBytes: policy.maxResponseBytes,
      pilotBoards: [...allowed],
    } });
    return results;
  }, { timeout: 60_000 });
  const receipt = { apply: true, releasedAt: now.toISOString(), serial: true, maximumJobs: REVIEWED_FIRST_COLLECTION_MAXIMUM_JOBS,
    released, deferred, ordinaryPolicyUnchanged: true };
  const receiptPath = args.find(arg => arg.startsWith('--receipt='))?.slice(10);
  if (receiptPath) { await mkdir(dirname(receiptPath), { recursive: true }); await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 }); }
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Reviewed release failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
