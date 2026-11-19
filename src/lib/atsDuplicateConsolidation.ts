import type { Prisma } from './prismaClient';
import { prisma } from './prisma';
import { directAtsPostingKey, findStoredAtsPostings, isAggregatorSource, selectDirectAtsMatch } from './atsDirectMatch';
import {
  findDirectAtsReprint, generatePostingIdentity, isDirectAtsReprint,
  isLikelyDuplicatePosting, normalizeUrl, type DuplicateJobIdentity,
} from './jobIngestion';
import { lockJobUrlEdits } from './jobUrlReconciliation';

/** A later direct sighting becomes the source of the existing saved card. */
export async function preferIncomingDirectAtsSource(
  tx: Prisma.TransactionClient, jobId: string, incoming: DuplicateJobIdentity, verifiedReprint = false,
): Promise<boolean> {
  if (!/^ATS-/i.test(incoming.source || '') || !incoming.sourceId || !incoming.url) return false;
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${jobId} FOR UPDATE`;
  const job = await tx.job.findUnique({ where: { id: jobId } });
  if (!job || /^ATS-/i.test(job.source || '') || !isAggregatorSource(job.source)) return false;
  if (job.passReason?.startsWith('Consolidated after URL edit into job ')) return false;
  if (job.userCanonicalUrl) return false;
  if (!verifiedReprint && !isLikelyDuplicatePosting(job, incoming) && !isDirectAtsReprint(job, incoming)) return false;
  const url = normalizeUrl(incoming.canonicalUrl || incoming.url);
  const postingIdentity = generatePostingIdentity({ ...incoming, canonicalUrl: url });
  if (postingIdentity) {
    const owner = await tx.job.findUnique({ where: { postingIdentity }, select: { id: true } });
    if (owner && owner.id !== jobId) return false;
  }
  // Source provenance survives even on historical rows without an observation.
  if (job.source && job.sourceId) await tx.jobSourceObservation.upsert({
    where: { source_sourceId: { source: job.source, sourceId: job.sourceId } },
    update: {}, create: { jobId, source: job.source, sourceId: job.sourceId, url: job.url },
  });
  // Retain the saved card ID, human decisions, all score inputs and score events.
  await tx.job.update({ where: { id: jobId }, data: {
    source: incoming.source!, sourceId: incoming.sourceId, url, canonicalUrl: url, postingIdentity, updatedAt: job.updatedAt,
  } });
  return true;
}

/** Existing copies are checked again when either source is rediscovered. */
export async function consolidateStoredAtsReprint(jobId: string, apply = true, store: Pick<typeof prisma, 'job' | '$transaction'> = prisma) {
  const job = await store.job.findFirst({ where: { id: jobId, status: { in: ['inbox', 'pending_af', 'applied', 'interviewing'] } } });
  if (!job || job.passReason?.startsWith('Consolidated after URL edit into job ')) return null;
  const match = await findDirectAtsReprint(job, jobId, store);
  if (!match) return null;
  const direct = /^ATS-/i.test(job.source || '') ? job : match;
  const aggregate = direct.id === job.id ? match : job;
  const url = direct.canonicalUrl || direct.url;
  if (!url) return null;
  const plan = { canonicalId: direct.id, redundantId: aggregate.id, url, title: direct.title, company: direct.company };
  // Looking from the employer card finds publishers, not rival requisitions.
  // Confirm the publisher's complete employer catalogue before claiming it.
  const catalogue = await findStoredAtsPostings(direct.company, store, [aggregate]);
  if (catalogue.incompleteEvidence || catalogue.verificationRequiredUrls?.includes(url)
    || catalogue.postings.some(posting => directAtsPostingKey(posting) !== directAtsPostingKey({ url })
      && selectDirectAtsMatch(aggregate, [posting]))) return null;
  if (!apply) return plan;
  const { reconcileRecoveredPosting } = await import('./canonicalMergeReview');
  return store.$transaction(async tx => {
    await lockJobUrlEdits(tx);
    for (const id of [direct.id, aggregate.id].sort()) await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${id} FOR UPDATE`;
    const rows = await tx.job.findMany({ where: { id: { in: [direct.id, aggregate.id] } } });
    const freshDirect = rows.find(row => row.id === direct.id);
    const freshAggregate = rows.find(row => row.id === aggregate.id);
    if (!freshDirect || !freshAggregate || +freshDirect.updatedAt !== +direct.updatedAt || +freshAggregate.updatedAt !== +aggregate.updatedAt
      || (freshDirect.userCanonicalUrl || freshDirect.canonicalUrl || freshDirect.url) !== url
      || !isDirectAtsReprint(freshDirect, freshAggregate)) return null;
    const result = await reconcileRecoveredPosting(tx, aggregate.id, url, freshAggregate.updatedAt, { expectedOwner: direct.id });
    return result === 'combined' ? plan : null;
  }, { timeout: 15_000 });
}
