import { load } from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';
import { expandedPostingIdentity, parseCornerstonePosting, parsePolymerDetail, polymerDetailRequest } from './expandedPublicAts';
import { readBoundedAtsBody } from './tenantAtsBoards';
import type { AtsScrapeResult } from './atsApi';

/** Exact posting reads share the same identity validation as acquisition. */
export async function fetchExpandedAtsPosting(url: string, read: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult | null> {
  const identity = expandedPostingIdentity(url);
  if (!identity || identity.platform === 'hireology') return null;
  const target = identity.platform === 'polymer' ? polymerDetailRequest(url)! : url;
  const response = await read(target, { headers: { Accept: 'application/json,text/html' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok || response.url && new URL(response.url).href !== new URL(target).href) return null;
  try {
    const body = await readBoundedAtsBody(response);
    const job = identity.platform === 'polymer' ? parsePolymerDetail(JSON.parse(body), url) : parseCornerstonePosting(body, url);
    const $ = load(String(job.description));
    $('script,style,template,[hidden],[aria-hidden="true"]').remove();
    $('p,div,li,br,h1,h2,h3,h4').append('\n');
    const text = $.text().replace(/[^\S\n]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, title: String(job.title), company: String(job.company), location: typeof job.location === 'string' ? job.location : undefined,
      ats: identity.platform === 'cornerstone' ? 'Cornerstone' : 'Polymer', platform: identity.platform, atsSlug: identity.slug };
  } catch { return null; }
}
