import type { Prisma } from './prismaClient';
import { lockJobUrlEdits } from './jobUrlReconciliation';
import { recordJobPipelineEvent } from './ingestionControl';
import { foldSameJob, pairKey, sameJobExceptionPairs, SameJobFoldSkipped } from './sameJobConsolidation';
import { savedPostingOwnerIds, type EmployerFacts } from './savedPostingOwner';
import { CONSOLIDATED_REASON_PREFIX } from './jobConsolidationReason';

/** Serialize with pasted links and reject stale verification before any fold or review. */
export async function reconcileRecoveredPosting(tx: Prisma.TransactionClient, id: string, url: string,
  stamp: Date, options: { where?: Prisma.JobWhereInput; leaseId?: string; facts?: EmployerFacts; expectedOwner?: string } = {},
): Promise<'unowned' | 'combined' | 'held' | 'stale'> {
  const { where, leaseId, facts, expectedOwner } = options;
  await lockJobUrlEdits(tx);
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${id} FOR UPDATE`;
  const copy = await tx.job.findFirst({ where: { ...where, id, updatedAt: stamp, userCanonicalUrl: null },
    select: { id: true, url: true, passReason: true } });
  if (!copy || copy.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX)) return 'stale';
  const owners = await savedPostingOwnerIds(tx, url, id);
  if (expectedOwner && !owners.includes(expectedOwner)) return 'stale';
  if (!owners.length) return 'unowned';
  const exceptions = await sameJobExceptionPairs(tx, [id]);
  const candidates = owners.filter(owner => !exceptions.has(pairKey(id, owner)));
  if (!candidates.length) return 'held';
  if (owners.length === 1) {
    try {
      await foldSameJob(tx, { redundantId: id, survivorId: owners[0], recoveredPosting: { url, facts, leaseId } });
      return 'combined';
    } catch (error) {
      if (!(error instanceof SameJobFoldSkipped)) throw error;
    }
  }
  await recordJobPipelineEvent({ eventType: 'canonical_merge_review', stage: 'canonical_recovery', jobId: id,
    identityParts: [copy.url || id, url, ...candidates.sort()],
    details: { url, ownerIds: candidates, sourceUrl: copy.url } }, tx);
  return 'held';
}

export async function pendingCanonicalReview(store: Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent' | '$queryRaw'>, id: string) {
  const event = await store.jobPipelineEvent.findFirst({ where: { jobId: id, eventType: 'canonical_merge_review' },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], select: { details: true } });
  const detail = event?.details as { url?: string; ownerIds?: string[]; sourceUrl?: string | null } | null;
  if (!detail?.url || !Array.isArray(detail.ownerIds)) return [];
  const copy = await store.job.findUnique({ where: { id }, select: { url: true, userCanonicalUrl: true, passReason: true } });
  if (!copy || copy.userCanonicalUrl || copy.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX)
    || copy.url !== detail.sourceUrl) return [];
  const url = detail.url;
  const owners = await savedPostingOwnerIds(store, url, id);
  const exceptions = await sameJobExceptionPairs(store, [id]);
  const ids = detail.ownerIds.filter(other => owners.includes(other) && !exceptions.has(pairKey(id, other)));
  const cards = await store.job.findMany({ where: { id: { in: ids } }, select: { id: true, company: true, title: true, status: true } });
  return cards.map(card => ({ ...card, url }));
}
