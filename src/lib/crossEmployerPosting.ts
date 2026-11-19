import type { Prisma } from './prismaClient';
import {
  boardIdentityFromUrl, declaredRequisitionId, directAtsPostingKey, directAtsTitleKey,
  findStoredAtsPostings, isAggregatorSource, isDirectPostingUrl, isSpecificPostingUrl,
  locationsCompatibleForDirectMatch, normalizeDirectPostingUrl, selectDirectAtsMatch,
  type DirectAtsMatch, type DirectMatchDeps, type DirectMatchJob, type BoardPosting,
} from './atsDirectMatch';
import { adpPostingsConflict } from './adpPostingIdentity';
import { extractPostedCompensation } from './postedCompensation';
import { canonicalEmployerPostingUrl } from './canonicalPosting';
import { descriptionContainment, descriptionShingles } from './appliedRepeatMatch';
import { findDirectAtsReprint } from './jobIngestion';
import { isUnusableDescription } from './sameJobMatch';
import { CONSOLIDATED_REASON_PREFIX } from './jobConsolidationReason';

const LIMIT = 100;
const MIN_SEQUENCES = 150;
type Store = DirectMatchDeps['store'];

function postingWords(description: string | null | undefined) {
  if (!description || description.length < 750 || isUnusableDescription(description)) return null;
  const words = descriptionShingles(description);
  return words.size >= MIN_SEQUENCES ? words : null;
}

function sameText(words: Set<string>, candidate: string | null | undefined) {
  const other = postingWords(candidate);
  if (!other) return false;
  const overlap = descriptionContainment(words, other) || 0;
  return overlap >= 0.95 && overlap * Math.min(words.size, other.size) >= 0.75 * Math.max(words.size, other.size);
}

const select = {
  id: true, updatedAt: true, title: true, company: true, source: true, url: true, canonicalUrl: true,
  userCanonicalUrl: true, location: true, description: true,
  observations: { where: { source: { startsWith: 'ATS-' } }, select: { url: true } },
} as const;
type Card = Prisma.JobGetPayload<{ select: typeof select }>;

function employerUrls(row: Card) {
  if (row.userCanonicalUrl) {
    const pinned = canonicalEmployerPostingUrl(row.userCanonicalUrl);
    return pinned ? [pinned] : [];
  }
  const direct = /^ATS-/i.test(row.source || '');
  const urls = [...[row.canonicalUrl, row.url].filter(url => direct || isDirectPostingUrl(url)),
    ...(row.observations || []).map(obs => obs.url).filter(url => !adpPostingsConflict(row.canonicalUrl || row.url, url))];
  const keys = new Set<string>();
  return urls.filter(isSpecificPostingUrl).filter(url => {
    const key = directAtsPostingKey({ url });
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

async function sameTitleCards(store: Store, title: string, where: Prisma.JobWhereInput) {
  return store.job.findMany({
    where: { AND: [where, { title: { equals: title.trim().replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } },
      { OR: [{ passReason: null }, { passReason: { not: { startsWith: CONSOLIDATED_REASON_PREFIX } } }] }] },
    select, take: LIMIT + 1,
  });
}

function agrees(copy: DirectMatchJob, official: BoardPosting, words: Set<string>) {
  if (isDirectPostingUrl(copy.canonicalUrl) && directAtsPostingKey({ url: copy.canonicalUrl! }) !== directAtsPostingKey(official)) return false;
  const req = declaredRequisitionId(copy.description);
  if (req && req !== declaredRequisitionId(official.description)) return false;
  const offeredPay = extractPostedCompensation(copy.description);
  const employerPay = extractPostedCompensation(official.description);
  if (offeredPay && employerPay && offeredPay !== employerPay) return false;
  return directAtsTitleKey(copy.title) === directAtsTitleKey(official.title)
    && locationsCompatibleForDirectMatch(copy.location, official.location)
    && selectDirectAtsMatch(copy, [official]) !== null && sameText(words, official.description);
}

function otherRequisition(job: DirectMatchJob, postings: BoardPosting[], url: string) {
  const key = directAtsPostingKey({ url });
  return postings.some(posting => directAtsPostingKey(posting) !== key && selectDirectAtsMatch(job, [posting]));
}

export function competingReprint(copy: DirectMatchJob, postings: BoardPosting[], url: string) {
  const words = postingWords(copy.description);
  const key = directAtsPostingKey({ url });
  return !!words && postings.some(posting => directAtsPostingKey(posting) !== key && agrees(copy, posting, words));
}

export type CrossEmployerResult = { kind: 'matched'; match: DirectAtsMatch } | { kind: 'unresolved' } | null;

/** A publisher name need not be the hiring employer. Never use a cross-company title alone. */
export async function findCrossEmployerPosting(job: DirectMatchJob, store: Store, known?: BoardPosting[]): Promise<CrossEmployerResult> {
  const words = postingWords(job.description);
  if (!words || !job.title.trim()) return null;
  const rows = await sameTitleCards(store, job.title, {});
  if (rows.length > LIMIT) return { kind: 'unresolved' };
  const candidates = rows.flatMap(row => {
    return employerUrls(row).filter(url => agrees(job, { ...row, url }, words)).map(url => ({ row, url }));
  });
  if (!candidates.length) return null;
  // Even two cards with the same URL have competing owners.
  if (candidates.length !== 1) return { kind: 'unresolved' };
  const { row, url } = candidates[0];
  // The named employer and the newly identified employer can each have a rival
  // with a punctuation/territory variant that an exact-title query never saw.
  if (!known) {
    const named = await findStoredAtsPostings(job.company, store, [job]);
    if (named.incompleteEvidence) return { kind: 'unresolved' };
    known = named.postings;
  }
  if (otherRequisition(job, known, url)) return { kind: 'unresolved' };
  const catalogue = await findStoredAtsPostings(row.company, store, [job]);
  if (otherRequisition(job, catalogue.postings, url) || catalogue.incompleteEvidence
    || catalogue.verificationRequiredUrls?.includes(url)
    || !catalogue.postings.some(p => directAtsPostingKey(p) === directAtsPostingKey({ url }))) return { kind: 'unresolved' };
  const board = boardIdentityFromUrl(url);
  return { kind: 'matched', match: {
    url: normalizeDirectPostingUrl(url), description: row.description, platform: board?.platform || 'unknown',
    slug: board?.slug || '', matchedVia: 'stored', matchedBy: 'description', postingTitle: row.title,
    postingLocation: /^ATS-/i.test(row.source || '') && [row.url, row.canonicalUrl].some(value =>
      value && directAtsPostingKey({ url: value }) === directAtsPostingKey({ url })) ? row.location : null,
  } };
}

/** The employer feed can arrive after the publisher. Verify the copy against
 * every already saved rival before letting this new requisition claim it. */
export async function findPublisherForIncomingPosting(job: DirectMatchJob, store: Store) {
  const url = job.canonicalUrl || job.url;
  if (!/^ATS-/i.test(job.source || '') || !isSpecificPostingUrl(url) || (job.description?.length || 0) < 750) return null;
  const rows = await sameTitleCards(store, job.title, { source: { not: { startsWith: 'ATS-' } } });
  if (rows.length > LIMIT) return null;
  const official = { title: job.title, location: job.location || null, description: job.description || null, url };
  const candidates = rows.filter(row => {
    const words = postingWords(row.description);
    return words && isAggregatorSource(row.source) && !row.userCanonicalUrl && !employerUrls(row).length && agrees(row, official, words);
  });
  if (candidates.length > 1) return null;
  // Retain the established same-employer, exact-body match for publishers
  // whose display title differs only in formatting.
  let copy: Card | null = candidates[0] || null;
  if (!copy) {
    const legacy = await findDirectAtsReprint(job, undefined, store);
    if (!legacy) return null;
    copy = await store.job.findUnique({ where: { id: legacy.id }, select });
    if (!copy || copy.userCanonicalUrl || employerUrls(copy).length) return null;
  }
  const existing = await findCrossEmployerPosting(copy, store);
  if (existing) return null;
  const companies = new Set([job.company, copy.company]);
  for (const company of companies) {
    const catalogue = await findStoredAtsPostings(company, store, [copy]);
    if (catalogue.incompleteEvidence || otherRequisition(copy, catalogue.postings, url)) return null;
  }
  return copy;
}
