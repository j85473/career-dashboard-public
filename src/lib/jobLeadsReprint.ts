import type { Job } from './prismaClient';
import { employerIdentityKey, sameEmployer } from './employerIdentity';
import { isUnusableDescription, sameJobLocationRelation, type SameJobEvidence } from './sameJobMatch';

export const JOBLEADS_REPRINT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type JobLeadsPosting = Pick<Job, 'source' | 'title' | 'company' | 'employer' | 'location'
  | 'description' | 'url' | 'canonicalUrl' | 'userCanonicalUrl' | 'postedAt'>;

function jobLeadsListingKey(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !/^(?:www\.)?jobleads\.com$/i.test(url.hostname)) return null;
    return /^\/[a-z]{2}\/job\/[a-z0-9-]+--([a-z0-9]{16,})\/?$/i.exec(url.pathname)?.[1].toLowerCase() || null;
  } catch {
    return null;
  }
}

function words(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function titleKey(title: string): string {
  // JobLeads expands the plural in this channel specialty. Keep other title
  // words, including levels, named partners, and territories.
  return words(title).replace(/\bvar(?:s| partners?)$/, 'var');
}

export function readJobLeadsReprint(posting: JobLeadsPosting) {
  const { description, url, canonicalUrl, userCanonicalUrl } = posting;
  if (posting.source !== 'JSearch' || userCanonicalUrl || !description) return null;
  const listingKey = jobLeadsListingKey(url);
  if (!listingKey || (canonicalUrl && listingKey !== jobLeadsListingKey(canonicalUrl))
    || isUnusableDescription(description)) return null;

  // Read the primary posting only. JobLeads repeats nearby titles in its
  // recommendations and wraps the posting in its own equivalently worded ads.
  const page = description.split(/^\s*#{0,3}\s*Similar jobs\b/im, 1)[0];
  const header = /^# ([^\n]+)\n+(?:## ([^\n]+)\n+)(?:## ([^\n]+)\n+)(?:## ([^\n]+)\n+)/m.exec(page);
  const title = titleKey(posting.title);
  if (!header || !title || titleKey(header[1]) !== title
    || !employerIdentityKey(posting, { excludeSharedPublishers: true })
    || !sameEmployer({ company: header[2] }, posting)) return null;
  const [, , , publishedLocation, workMode] = header;
  if (!/^(?:remote|hybrid|on[- ]site)$/i.test(workMode.trim())
    || /^(?:unknown|not specified|remote|hybrid|on[- ]site)(?: location)?$/i.test(publishedLocation.trim())
    || sameJobLocationRelation(posting.location, publishedLocation) === 'conflict') return null;

  const section = /^### (?:Key )?Responsibilities\s*\r?\n([\s\S]*?)(?=^#{1,6} |(?![\s\S]))/im.exec(page.slice(header.index));
  const lines = section?.[1].trim().split(/\r?\n/).filter(line => line.trim()) || [];
  const duties = lines.map(line => words(line.replace(/^\s*[*•-]\s+/, '')));
  // A complete, substantial set of distinct bullets is evidence about the
  // opening. A title, teaser, boilerplate, or partially matching list is not.
  if (new Set(duties).size < 5 || duties.some(line => line.split(' ').length < 7)
    || lines.some(line => !/^\s*[*•-]\s+/.test(line))
    || duties.join(' ').split(' ').length < 60) return null;

  // A repost may mention an employer requisition explicitly. Preserve every
  // such identifier so competing employer IDs always defeat the text match.
  const requisitions = new Set(Array.from(page.matchAll(
    /\b(?:req(?:uisition)?\s*(?:id|number|no\.?|#)|requisition|job\s*id)\s*[:#]?\s*((?=[a-z0-9-]*\d)[a-z0-9][a-z0-9-]{2,})\b/gi,
  ), match => match[1].toLowerCase()));
  if (requisitions.size > 1) return null;
  return { posting, title, publishedLocation, workMode: words(workMode), duties: duties.join('\n'),
    requisition: [...requisitions][0] ?? null };
}

export type JobLeadsReprint = NonNullable<ReturnType<typeof readJobLeadsReprint>>;

export function matchJobLeadsReprints(left: JobLeadsReprint, right: JobLeadsReprint): SameJobEvidence | null {
  if (left.title !== right.title || left.duties !== right.duties || left.workMode !== right.workMode
    || !sameEmployer(left.posting, right.posting)
    || Math.abs(+left.posting.postedAt - +right.posting.postedAt) > JOBLEADS_REPRINT_WINDOW_MS
    || (left.requisition && right.requisition && left.requisition !== right.requisition)
    || sameJobLocationRelation(left.posting.location, right.posting.location) === 'conflict'
    || sameJobLocationRelation(left.posting.location, right.publishedLocation) === 'conflict'
    || sameJobLocationRelation(left.publishedLocation, right.posting.location) === 'conflict') return null;
  const location = sameJobLocationRelation(left.publishedLocation, right.publishedLocation);
  return location === 'conflict' ? null : {
    rule: 'jobleads_responsibilities', employer: 'same', location, containment: null,
  };
}
