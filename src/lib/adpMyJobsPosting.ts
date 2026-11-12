import * as cheerio from 'cheerio';
import type { AtsScrapeResult } from './atsApi';
import { safeExternalFetch } from './safeExternalFetch';
import { publishedEmployerName } from './publicAtsEmployer';
import { postingUrlsMatch } from './postingMetadata';

export function adpMyJobsIdentity(value: string): { site: string; id: string } | null {
  try {
    const url = new URL(value);
    const match = /^\/([a-z0-9_-]+)\/cx\/job-details\/?$/i.exec(url.pathname);
    const ids = url.searchParams.getAll('reqId');
    return url.protocol === 'https:' && url.hostname === 'myjobs.adp.com' && !url.port && !url.username && !url.password
      && match && ids.length === 1 && /^\d+$/.test(ids[0]) ? { site: match[1], id: ids[0] } : null;
  } catch { return null; }
}

type Site = { domain?: unknown; active?: unknown; settings?: { externalId?: unknown; careerSiteType?: unknown }; clientName?: unknown; myJobsToken?: unknown };
type Job = { itemID?: unknown; requisitionTitle?: unknown; requisitionDescription?: unknown;
  postingInstructions?: Array<{ postingChannel?: { channelID?: unknown } }>;
  screeningRequirements?: Array<{ requirementDescription?: unknown }>;
  requisitionLocations?: Array<{ postingIndicator?: boolean; address?: { cityName?: unknown; countrySubdivisionLevel1?: { longName?: unknown; codeValue?: unknown }; country?: { longName?: unknown } }; nameCode?: { shortName?: unknown; longName?: unknown } }> };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function parseAdpMyJobsPosting(body: unknown, value: string, config: unknown): AtsScrapeResult | null {
  const identity = adpMyJobsIdentity(value);
  const site = config as Site | null;
  if (!identity || !site || site.domain !== identity.site || site.active !== true || site.settings?.careerSiteType !== 'External'
    || !/^\d+$/.test(String(site.settings?.externalId))) return null;
  const jobs = (body as { jobRequisitions?: Job[] } | null)?.jobRequisitions;
  if (!Array.isArray(jobs) || jobs.length !== 1) return null;
  const job = jobs[0];
  if (!job || String(job.itemID) !== identity.id || !text(job.requisitionTitle) || !text(job.requisitionDescription)
    || !Array.isArray(job.postingInstructions) || !job.postingInstructions.some(p =>
      String(p?.postingChannel?.channelID) === String(site.settings?.externalId))
    || job.screeningRequirements != null && !Array.isArray(job.screeningRequirements)
    || job.requisitionLocations != null && !Array.isArray(job.requisitionLocations)) return null;
  if ((job.screeningRequirements || []).some(r => !r || typeof r !== 'object')
    || (job.requisitionLocations || []).some(p => !p || typeof p !== 'object')) return null;
  const requirements = (job.screeningRequirements || []).map(r => text(r.requirementDescription)).filter(Boolean);
  const $ = cheerio.load([job.requisitionDescription, ...(requirements.length ? ['<h3>Requirements</h3>', ...requirements] : [])].join('\n'));
  $('script,style').remove();
  $('p,div,li,h1,h2,h3,h4,br').append('\n');
  const description = $.root().text().replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  const locations = (job.requisitionLocations || []).filter(p => p.postingIndicator !== false).map(p => {
    const address = p.address;
    return [text(address?.cityName), text(address?.countrySubdivisionLevel1?.longName) || text(address?.countrySubdivisionLevel1?.codeValue), text(address?.country?.longName)].filter(Boolean).join(', ')
      || text(p.nameCode?.shortName) || text(p.nameCode?.longName);
  }).filter(Boolean);
  return { ats: 'ADP', title: text(job.requisitionTitle), company: publishedEmployerName(site.clientName) || undefined,
    location: [...new Set(locations)].join('; ') || undefined, text: description };
}

/** The public site config grants access to its published requisitions, never applicant data. */
export async function fetchAdpMyJobsPosting(value: string, read: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult> {
  const identity = adpMyJobsIdentity(value);
  const failure: AtsScrapeResult = { ats: 'ADP', text: '', postingVerificationError: 'ADP did not return verified details for this opening. The saved details and scores were kept.' };
  if (!identity) return failure;
  const signal = AbortSignal.timeout(15_000);
  try {
    const siteUrl = `https://myjobs.adp.com/public/staffing/v1/career-site/${identity.site}`;
    const response = await read(siteUrl, { headers: { Accept: 'application/json' }, signal });
    if (!response.ok || response.url && !postingUrlsMatch(response.url, siteUrl)) return failure;
    const site = await response.json() as Site;
    if (site.domain !== identity.site || site.active !== true || site.settings?.careerSiteType !== 'External'
      || !/^\d+$/.test(String(site.settings?.externalId)) || !text(site.myJobsToken)) return failure;
    // Pin the public API host/path; configuration cannot redirect token-bearing requests.
    const endpoint = `https://my.adp.com/myadp_prefix/mycareer/public/staffing/v1/job-requisitions/search-meta/${identity.id}`;
    const detail = await read(endpoint, { headers: { Accept: 'application/json', 'Accept-Language': 'en-US', myJobsToken: text(site.myJobsToken) }, signal, redirect: 'error' });
    if (!detail.ok || detail.url && !postingUrlsMatch(detail.url, endpoint)) return failure;
    return parseAdpMyJobsPosting(await detail.json(), value, site) || failure;
  } catch { return failure; }
}
