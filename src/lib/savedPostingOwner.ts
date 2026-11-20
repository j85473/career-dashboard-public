import { Prisma, type Job } from './prismaClient';
import { directAtsPostingKey, isDirectPostingUrl, isSpecificPostingUrl, verifiedEmployerLocation } from './atsDirectMatch';
import { urlPostingIdentity } from './jobUrlReconciliation';
import { CONSOLIDATED_REASON_PREFIX } from './jobConsolidationReason';
import { automaticGeographyReason, planPostingMetadataRepair } from './postingMetadataRepair';
import { jobsWithOwnLifecycleDecision } from './appliedDuplicateStore';
import { evaluateAuthoritativeMetadata } from './authoritativeMetadataGate';
import { passesPreFilter } from './jobFiltering';
import { isClosedJobPosting, isScorableJobDescription } from './jobDescriptionQuality';
import { isManualImportSource } from './manualImportPolicy';
import { recordJobPipelineEvent } from './ingestionControl';
import { canonicalEmployerPostingUrl, canonicalPostingDescription, readCanonicalPosting } from './canonicalPosting';
import { derivePostingFacts } from './postingFacts';
import { loadEmployerRuleIndex } from './employerRuleStore';
import { resolveEmployer } from './employerIdentity';
import { generateV4Fingerprint } from './jobIngestion';

// These providers have dedicated posting-identity extractors. Many ordinary
// branded links share paths or unscoped numbers, so only their URLs can agree.
const scopedProvider = /(?:\.myworkdayjobs\.com|\.myworkdaysite\.com|\.adp\.com|\.paylocity\.com|\.dayforcehcm\.com|\.dayforce\.com)$/i;

export function sameEmployerPosting(left: string | null | undefined, right: string) {
  if (!isSpecificPostingUrl(left) || !isSpecificPostingUrl(right)) return false;
  if (directAtsPostingKey({ url: left }) === directAtsPostingKey({ url: right })) return true;
  const key = urlPostingIdentity(left);
  return !!key && scopedProvider.test(new URL(left).hostname) && key === urlPostingIdentity(right);
}

/** Read exact owners before considering title hints; competing owners stay distinct. */
export async function savedPostingOwnerIds(store: Pick<Prisma.TransactionClient, '$queryRaw' | 'job'>, url: string, excludeId = '') {
  if (!isSpecificPostingUrl(url)) return [];
  const parsed = new URL(url);
  const equivalentUrls = new Set([url, directAtsPostingKey({ url })]);
  if (/^(boards|job-boards)\.greenhouse\.io$/i.test(parsed.hostname)) {
    const other = new URL(parsed);
    other.hostname = parsed.hostname === 'boards.greenhouse.io' ? 'job-boards.greenhouse.io' : 'boards.greenhouse.io';
    equivalentUrls.add(other.href);
  }
  const urls = [...equivalentUrls].filter(value => /^https?:/i.test(value));
  const keys = urls.map(urlPostingIdentity).filter((key): key is string => !!key);
  const exactUrls = Prisma.join(urls);
  const jobUrlKeys = Prisma.join(urls.map(value => Prisma.sql`left(lower(${value}::text), 512)`));
  const observationUrlKeys = Prisma.join(urls.map(value => Prisma.sql`left(${value}::text, 512)`));
  // Isolate the indexed prefix lookup so the full URL comparison cannot
  // make PostgreSQL choose a costly trigram scan on large tables.
  const hits = await store.$queryRaw<Array<{ id: string }>>`
    WITH url_candidates AS MATERIALIZED (
      SELECT id, url FROM "Job" WHERE left(lower(url), 512) COLLATE "C" IN (${jobUrlKeys})
      UNION ALL
      SELECT "jobId", url FROM "JobSourceObservation"
      WHERE source LIKE 'ATS-%' AND left(url, 512) COLLATE "C" IN (${observationUrlKeys})
    )
    SELECT id FROM "Job" WHERE lower("canonicalUrl") IN (${Prisma.join(urls.map(value => value.toLowerCase()))})
    UNION SELECT id FROM url_candidates WHERE url IN (${exactUrls})
    ${keys.length ? Prisma.sql`UNION SELECT id FROM "Job" WHERE "postingIdentity" IN (${Prisma.join(keys)})` : Prisma.empty}`;
  const possible = hits.map(hit => hit.id).filter(id => id !== excludeId);
  if (!possible.length) return [];
  const rows = await store.job.findMany({ where: { id: { in: possible } },
    select: { id: true, url: true, canonicalUrl: true, userCanonicalUrl: true, postingIdentity: true, passReason: true,
      observations: { where: { source: { startsWith: 'ATS-' }, url: { in: urls } }, select: { url: true } } } });
  return rows.filter(row => {
    if (row.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX)) return false;
    if (row.userCanonicalUrl) return sameEmployerPosting(row.userCanonicalUrl, url);
    const links = [row.canonicalUrl, row.url];
    if (links.some(link => sameEmployerPosting(link, url))) return true;
    if (links.some(isDirectPostingUrl)) return false;
    return row.observations.some(obs => sameEmployerPosting(obs.url, url))
      || scopedProvider.test(parsed.hostname) && !!row.postingIdentity && keys.includes(row.postingIdentity) && links.every(link => !link || !urlPostingIdentity(link));
  }).map(row => row.id);
}

export type EmployerFacts = { title: string; company: string; location: string | null; description: string | null; url: string };

// Network reads happen before locking. Only an eligible inactive owner needs
// a new employer read; all lifecycle checks run again on the locked row.
export async function readArchivedOwnerFacts(store: Pick<Prisma.TransactionClient, 'job'>, url: string) {
  if (!canonicalEmployerPostingUrl(url)) return undefined;
  const owner = await store.job.findFirst({ where: {
    OR: [{ url }, { canonicalUrl: url }], status: { in: ['archived', 'dismissed'] },
    passReason: { not: null }, aimFitScore: null, fitScore: null, reqFitScore: null,
    tailoringStaged: false, userCanonicalUrl: null, submittedResume: null, scoreEvents: { none: {} },
  }, select: { status: true } });
  if (!owner || !['archived', 'dismissed'].includes(owner.status)) return undefined;
  const posting = await readCanonicalPosting(url);
  const description = canonicalPostingDescription(posting?.text);
  return posting?.title && posting.company && posting.location && description
    ? { url, title: posting.title, company: posting.company, location: posting.location, description } : undefined;
}

/** Return whether an inactive machine disposition is still supported. Only
 * newly verified employer facts can return an unscored card to local triage. */
export async function recheckPostingDisposition(tx: Prisma.TransactionClient, job: Job, facts?: EmployerFacts) {
  if (!['archived', 'dismissed'].includes(job.status)) return true;
  if ((await jobsWithOwnLifecycleDecision(tx, [job.id])).has(job.id)) return true;
  if (job.tailoringStaged || job.submittedResume || job.userCanonicalUrl || isManualImportSource(job.source)
    || job.jdBatchId || job.batchJobId || job.afBatchId || job.contextBatchId || job.scoringStatus === 'scoring') return false;
  const evidence = facts || (/^ATS-/i.test(job.source || '') && job.url ? { ...job, url: job.url } : null);
  if (!evidence) return false;
  const posting = { ...evidence, description: evidence.description || '', location: evidence.location || '' };
  if (isClosedJobPosting(posting.description) || !passesPreFilter(posting).passes
    || !evaluateAuthoritativeMetadata(posting).passes) return true;
  if (!facts || !job.passReason || !verifiedEmployerLocation(facts.location)
    || !isScorableJobDescription(facts.description || '', { structuredSource: true })) return false;
  const geo = automaticGeographyReason(job.passReason);
  // Other machine rejections must have the original intake rejection receipt;
  // a user's pass, model score or an unexplained legacy status cannot be reopened.
  if (!geo && !await tx.jobPipelineEvent.findFirst({ where: { jobId: job.id, eventType: 'prefilter_rejected',
    details: { path: ['reason'], equals: job.passReason } }, select: { id: true } })) return false;
  if (job.aimFitScore !== null || job.reqFitScore !== null || job.fitScore !== null
    || await tx.jobScoreEvent.count({ where: { jobId: job.id } })
    || await tx.scoringBatchItem.count({ where: { jobId: job.id, status: 'leased' } })) return false;
  if (geo && planPostingMetadataRepair(job, { ...facts, location: facts.location!, source: 'employer_posting',
    identityVerified: true, completeLocations: true }, { hasScores: false, hasHumanDecision: false })?.action !== 'restore_for_review') return false;
  await tx.job.update({ where: { id: job.id }, data: {
    status: 'pending_af', scoringStatus: 'queued', passReason: null, scoreError: null, contextBatched: false,
    title: facts.title, company: facts.company, location: facts.location, description: facts.description,
    employer: resolveEmployer({ company: facts.company, url: facts.url, source: job.source }, await loadEmployerRuleIndex(tx)),
    ...derivePostingFacts(facts.description),
    identityFingerprint: generateV4Fingerprint(facts.title, facts.company, facts.location!),
  } });
  await recordJobPipelineEvent({ jobId: job.id, eventType: 'lifecycle_reconciled', stage: 'ingestion',
    identityParts: ['canonical_disposition', job.updatedAt.toISOString()], details: { actor: 'system',
      route: 'canonical_disposition', priorStatus: job.status, nextStatus: 'pending_af', priorReason: job.passReason, url: facts.url } }, tx);
  return true;
}
