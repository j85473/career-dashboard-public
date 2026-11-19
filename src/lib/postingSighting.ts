import type { Prisma } from './prismaClient';
import { isAggregatorSource, isDirectPostingUrl, isSpecificPostingUrl, directAtsPostingKey } from './atsDirectMatch';
import { findCrossEmployerPosting, findPublisherForIncomingPosting } from './crossEmployerPosting';
import { savedPostingOwnerIds, sameEmployerPosting, recheckPostingDisposition, type EmployerFacts } from './savedPostingOwner';
import { preferIncomingDirectAtsSource } from './atsDuplicateConsolidation';
import { retainAggregatorCandidate } from './aggregatorIntakeQueue';
import type { IncomingJob } from './jobIngestion';
import { recordJobPipelineEvent } from './ingestionControl';
import { CONSOLIDATED_REASON_PREFIX } from './jobConsolidationReason';

type Incoming = { title: string; company: string; location: string; description: string;
  source: string; sourceId: string; url: string; canonicalUrl: string };
type Observation = Omit<Prisma.JobSourceObservationUncheckedCreateInput, 'jobId' | 'id' | 'observedAt'>;

/** The lookup and the caller's insert share a transaction. Concurrent feeds
 * cannot both conclude that a substantial same-title reprint is the first. */
export async function claimPostingBeforeInsert(tx: Prisma.TransactionClient, incoming: Incoming,
  observation: Observation, retry: { job: IncomingJob; context: Record<string, unknown> }, facts?: EmployerFacts,
): Promise<'duplicate' | 'filtered' | null> {
  const url = incoming.canonicalUrl || incoming.url;
  const direct = /^ATS-/i.test(incoming.source);
  if (!direct && !isAggregatorSource(incoming.source)) return null;
  const official = isSpecificPostingUrl(url) && (direct || isDirectPostingUrl(url) || !!facts);
  const substantial = incoming.description.length >= 750;
  if (!official && !substantial) return null;
  const locks = [...(substantial ? ['title:' + incoming.title.trim().toLowerCase()] : []),
    ...(official ? ['url:' + directAtsPostingKey({ url })] : [])];
  for (const lock of locks) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'posting-sighting:' + lock}, 0))`;
  if (await tx.jobSourceObservation.findUnique({ where: { source_sourceId: { source: observation.source, sourceId: observation.sourceId } },
    select: { id: true } })) return 'duplicate';

  async function hold(reason: string) {
    const originalUrl = observation.url || url;
    await retainAggregatorCandidate({ ...retry, source: incoming.source, sourceId: incoming.sourceId,
      company: incoming.company, title: incoming.title, url: originalUrl, expired: false, reason }, tx);
    await recordJobPipelineEvent({ eventType: 'canonical_intake_pending', stage: 'ingestion', source: incoming.source,
      sourceId: incoming.sourceId, taskId: observation.taskId, details: { reason, url: originalUrl } }, tx);
    return 'filtered' as const;
  }

  let targetUrl = official ? url : null;
  let owners = targetUrl ? await savedPostingOwnerIds(tx, targetUrl) : [];
  if (owners.length > 1) return hold('multiple_saved_posting_owners');
  const publisher = !owners.length && direct ? await findPublisherForIncomingPosting(incoming, tx) : null;
  let owner: string | undefined = owners[0] || publisher?.id;
  if (!owner && !official && substantial) {
    const cross = await findCrossEmployerPosting(incoming, tx);
    if (cross?.kind === 'unresolved') return hold('cross_employer_unresolved');
    if (cross?.kind === 'matched') {
      targetUrl = cross.match.url;
      owners = await savedPostingOwnerIds(tx, targetUrl);
      if (owners.length !== 1) return hold('cross_employer_unresolved');
      owner = owners[0];
    }
  }
  if (!owner || !targetUrl) return null;
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${owner} FOR UPDATE`;
  const saved = await tx.job.findUniqueOrThrow({ where: { id: owner } });
  if (saved.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX)
    || saved.userCanonicalUrl && !sameEmployerPosting(saved.userCanonicalUrl, targetUrl)) return null;
  if (publisher) {
    if (+saved.updatedAt !== +publisher.updatedAt || (await savedPostingOwnerIds(tx, targetUrl)).length) {
      return hold('posting_owner_changed');
    }
    if (!await preferIncomingDirectAtsSource(tx, owner, incoming, true)) return null;
  } else {
    const confirmed = await savedPostingOwnerIds(tx, targetUrl);
    if (confirmed.length !== 1 || confirmed[0] !== owner) return hold('posting_owner_changed');
  }
  await recheckPostingDisposition(tx, saved, facts);
  await tx.jobSourceObservation.create({ data: { ...observation, jobId: owner } });
  await recordJobPipelineEvent({ eventType: 'duplicate', stage: 'ingestion', jobId: owner, source: incoming.source,
    sourceId: incoming.sourceId, taskId: observation.taskId, queryFamily: observation.queryFamily, geoLane: observation.geoLane,
    details: { reason: 'confirmed_employer_posting', url: targetUrl } }, tx);
  return 'duplicate';
}
