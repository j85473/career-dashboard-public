import { AdpEmployerEvidence, adpCareerCenterUrl, readAdpPublicJson, AdpPublicResponseError, type AdpCareerCenter } from './adpEmployerEvidence';
export { adpClientFeaturesUrl, parseAdpClientCompany } from './adpEmployerEvidence';
import * as cheerio from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';
import { adpPostingIdentity } from './adpPostingIdentity';
import { publishedEmployerName } from './publicAtsEmployer';

export { adpPostingIdentity } from './adpPostingIdentity';

export function adpPostingDetailUrl(value: string): string | null {
  const identity = adpPostingIdentity(value);
  if (!identity) return null;
  const url = new URL(`/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/${identity.jobId}`, identity.origin);
  for (const [key, value] of Object.entries({ cid: identity.cid, ccId: identity.ccId, lang: 'en_US', locale: 'en_US' })) url.searchParams.set(key, value);
  return url.toString();
}

/** Only authored employer sections or explicit named-employer EEO statements
 * supply identity. Editor wrappers, clients and conflicting names do not. */
function authoredAdpEmployer($: cheerio.CheerioAPI): string | undefined {
  const names = new Map<string, string>();
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  // Read content blocks in document order so an About heading nested inside a
  // formatting div can still introduce the following paragraph outside it.
  const blocks = $('h1,h2,h3,h4,p,li,div').toArray()
    .filter(node => !$(node).find('h1,h2,h3,h4,p,li,div').length)
    .map(node => normalize($(node).text())).filter(Boolean);
  const postingText = blocks.join(' ');
  const key = (name: string) => name.replace(/\s+\([A-Z0-9&.-]{2,15}\)$/, '').toLowerCase();
  const employerName = (subject: unknown) => {
    const name = publishedEmployerName(subject);
    return name && name.length <= 100 && !/^(?:we|it|this|our|your|you|all|each|every)\b|^(?:the company|the team|the role)$|\b(?:is|are|was|were|will|must|should|which|that|clients?|customers?)\b|[!?;:]/i.test(name)
      ? name : '';
  };
  for (let index = 0; index < blocks.length; index++) {
    const heading = blocks[index];
    const next = blocks.slice(index + 1, index + 11);
    const named = /^About\s+(.{2,100}?)\s*:?$/i.exec(heading);
    if (named && !/^(?:us|the role|the company|you|the team)$|^(?:our|the) (?:clients?|customers?)\b/i.test(named[1])
      && (next[0]?.startsWith(`At ${named[1]},`) || next[0]?.startsWith(`${named[1]} `))) {
      const name = publishedEmployerName(named[1]);
      if (name) names.set(key(name), name);
    }
    if (!/^(?:about us|company overview)\s*:?$/i.test(heading)) continue;
    const subject = /^(.{2,100}?)\s+(?:is|are)\b/i.exec(next[0] || '')?.[1];
    const name = employerName(subject);
    if (!name
      || /^\s+(?:is|are)\s+(?:a|our|the)\s+(?:client|customer)\b/i.test((next[0] || '').slice(subject!.length))) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hiring = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}\\s+(?:is|are)\\s+(?:seeking|hiring|recruiting|looking\\s+for)\\b`, 'iu');
    if (hiring.test(postingText) || /\bour (?:team|company|spas|employees|organization|staff)\b/i.test(next.slice(0, 3).join(' '))) names.set(key(name), name);
  }
  for (const block of blocks) {
    // Require a sentence-start subject, rather than pulling a client name out
    // of a sentence about another organization. Never use a generic EEO label.
    const subject = /^(.{2,100}?)\s+is\s+an?\s+equal\s+(?:employment\s+)?opportunity\s+employer\b/i.exec(block)?.[1];
    const name = employerName(subject);
    if (name) names.set(key(name), name);
  }
  return names.size === 1 ? [...names.values()][0] : undefined;
}

export function parseAdpPosting(body: unknown, url: string) {
  const identity = adpPostingIdentity(url);
  if (!identity || !body || typeof body !== 'object') return null;
  const job = body as { requisitionTitle?: string; requisitionDescription?: string;
    customFieldGroup?: { stringFields?: Array<{ stringValue?: string; nameCode?: { codeValue?: string } }> };
    requisitionLocations?: Array<{ nameCode?: { shortName?: string } }> };
  const id = job.customFieldGroup?.stringFields?.find(field => field.nameCode?.codeValue === 'ExternalJobID')?.stringValue;
  if (id !== identity.jobId || !job.requisitionTitle?.trim() || typeof job.requisitionDescription !== 'string') return null;
  const $ = cheerio.load(job.requisitionDescription);
  $('script,style').remove();
  const company = authoredAdpEmployer($);
  $('p,div,li,h1,h2,h3,br').append('\n');
  const text = $.root().text().replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  const locations = [...new Set((job.requisitionLocations || []).map(place => place.nameCode?.shortName?.trim()).filter(Boolean))];
  return { ats: 'ADP', title: job.requisitionTitle.trim(), company,
    location: locations.join('; ') || undefined, text };
}

export async function fetchAdpPosting(url: string, fetchPage: typeof safeExternalFetch = safeExternalFetch) {
  const endpoint = adpPostingDetailUrl(url);
  if (!endpoint) return null;
  const response = await fetchPage(endpoint, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok || (response.url && response.url !== endpoint)) return null;
  const posting = parseAdpPosting(await response.json(), url);
  if (!posting || posting.company) return posting;
  const json = (target: string) => readAdpPublicJson(target, fetchPage);
  const employer = new AdpEmployerEvidence({
    json, fetcher: fetchPage, check: async () => {},
    careerCenter: async () => {
      const body = await json(adpCareerCenterUrl(url)!);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AdpPublicResponseError('ADP career-center schema changed');
      return body as AdpCareerCenter;
    },
  });
  posting.company = await employer.company(url, posting.text);
  return posting;
}
