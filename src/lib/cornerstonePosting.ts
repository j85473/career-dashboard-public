import { load } from 'cheerio';
import { expandedBoardSlug, expandedConfig, expandedPostingIdentity, parseCornerstonePosting } from './expandedPublicAts';
import { US_STATE_LOCATION_PATTERN } from './postingLocation';
import { publishedEmployerName } from './publicAtsEmployer';
import { AtsDetailHttpError, AtsDetailResponseError } from './atsDetailRequest';
import { AtsFirstCollectionSizeError, readBoundedAtsBody } from './tenantAtsBoards';

type Row = Record<string, unknown>;
export type CornerstoneReadOptions = Pick<RequestInit, 'headers' | 'redirect'>;
export type CornerstoneEvidenceReader = (url: string, options?: CornerstoneReadOptions) => Promise<Response>;
const text = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
const row = (v: unknown): Row => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AtsDetailResponseError('Cornerstone evidence must be an object');
  return v as Row;
};
const rows = (v: unknown): Row[] => {
  if (!Array.isArray(v)) throw new AtsDetailResponseError('Cornerstone evidence must contain an array');
  return v.map(row);
};
const requireEvidence = (condition: unknown, message: string): void => {
  if (!condition) throw new AtsDetailResponseError(`Cornerstone ${message}`);
};
const US_COUNTRY = /^(?:US|USA|United States(?: of America)?)$/i;
const US_WORKSITE_TITLE = new RegExp(
  `^\\p{L}[\\p{L} .’'-]*,\\s*${US_STATE_LOCATION_PATTERN}(?:\\s+\\((?:main|hq|headquarters|office|plant|site)\\))?$`,
  'iu',
);

function cornerstoneWorksiteLocation(worksite: Row): string {
  const [city, state, country] = [worksite.city, worksite.state, worksite.country].map(text);
  const title = text(worksite.title);
  // Some tenants publish the city and state only in the worksite's display name.
  if (!city && !state && US_COUNTRY.test(country) && US_WORKSITE_TITLE.test(title)) {
    return `${title}, ${country}`;
  }
  return [city, state, country].filter(Boolean).join(', ');
}

export async function readCornerstoneBody(response: Response): Promise<string> {
  try { return await readBoundedAtsBody(response); }
  catch (error) {
    if (error instanceof AtsFirstCollectionSizeError) throw new AtsDetailResponseError('Cornerstone posting evidence exceeds the response allowance', error);
    throw error;
  }
}
const cleanName = (input: string): string => {
  const name = publishedEmployerName(input.replace(/^The\s+/i, ''));
  return name.length >= 2 && name.length <= 120 && !/[!?<>:]/.test(name)
    && !/^(?:we|us|you|our|your|their|this|that|a|an|the company)\b|\b(?:customer|client|partner|applicant|candidate)\b/i.test(name)
    && !/^(?:join|work|working|apply|careers?|jobs?|benefits|about|why|role|team|unknown|confidential|cornerstone)(?:\b|$)/i.test(name)
    ? name : '';
};

/** Only explicit employer statements in this requisition's authored ad count.
 * Names in prose, tenant/site branding, image filenames and neighbouring jobs
 * are not fallback identity sources. Multiple distinct statements stay held. */
export function cornerstoneJobAdEmployer(ad: string, requested: string, title: string, reference: string): string {
  // Source newlines inside a paragraph are HTML whitespace, not evidence lines.
  const $ = load(ad.replace(/\r?\n/g, ' '));
  $('script,style,template,blockquote,[hidden],[aria-hidden="true"]').remove();
  $('br').replaceWith('\n');
  $('p,div,li,tr,td,th,dt,dd,h1,h2,h3,h4,h5,h6').append('\n');
  const lines = $.root().text().split(/\r?\n/).map(text).filter(Boolean);
  const candidates = new Map<string, string>();
  const add = (raw: string) => { const name = cleanName(raw); if (name) candidates.set(name.toLocaleLowerCase('en-US'), name); };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const label = /^(?:Hiring (?:organization|company)|Employer|Company)\s*:\s*(.{2,120})$/i.exec(line);
    if (label) add(label[1]);
    if (/^(?:Hiring (?:organization|company)|Employer|Company)\s*:?$/i.test(line)) add(lines[index + 1] || '');
    const equalOpportunity = /^(.{2,120}?) is (?:an? |proud to be an? )equal opportunity employer\b/i.exec(line);
    if (equalOpportunity) add(equalOpportunity[1]);
    // Some university templates name the employer immediately before "We are".
    const hiring = /^(.{2,120}?) is committed to hiring and retaining\b[^.]*\.\s*We are an? Equal Opportunity Employer\b/i.exec(line);
    if (hiring) add(hiring[1]);

    // A recruiting heading must agree with the ad's explicit self-introduction.
    // A "Why JPS?" heading may corroborate "JPS Health Network is a ...".
    const heading = /^(?:Why (?:join |work (?:at|for) )?([^?!.:]{2,100})\?|About ([^?!.:]{2,100}):?)$/i.exec(line);
    if (heading) {
      const shortName = cleanName(heading[1] || heading[2]);
      if (!shortName) continue;
      const matches = lines.flatMap(candidate => {
        const intro = /^(.{2,120}?) is (?:an? |one of (?:the |our )?)/i.exec(candidate);
        const name = intro ? cleanName(intro[1]) : '';
        return name && (name.toLowerCase() === shortName.toLowerCase()
          || name.toLowerCase().startsWith(`${shortName.toLowerCase()} `)) ? [name] : [];
      });
      if (matches.some(name => name.toLowerCase() === shortName.toLowerCase())) add(shortName);
      else for (const name of matches) add(name);
    }
  }

  // Linde's published template explicitly separates the hiring legal entity,
  // role and requisition reference. This reads the entity, never a tenant map.
  if (new URL(requested).hostname === 'linde.csod.com') {
    const employer = $('.above-job-title'), role = $('.job-title'), posting = $('.below-job-title');
    if (employer.length === 1 && role.length === 1 && posting.length === 1
      && employer.next().is(role) && role.next().is(posting)
      && text(role.text()) === title && text(posting.text()).split(/[|｜]/).at(-1)?.trim() === reference) add(employer.text());
  }
  return candidates.size === 1 ? [...candidates.values()][0] : '';
}

function legacyFields(payload: unknown): Row {
  const response = row(payload);
  requireEvidence(response.status === 200 && response.totalRecords === 1, 'job-ad service did not return one record');
  const data = rows(response.data);
  requireEvidence(data.length === 1, 'job-ad service returned ambiguous data');
  const items = rows(data[0].items);
  requireEvidence(items.length === 1, 'job-ad service returned ambiguous items');
  return row(items[0].fields);
}

/** Resolve a shell-only page using the same anonymous services as its public
 * client. Tokens stay in request headers; no employer is cached across jobs. */
export async function readCornerstonePosting(html: string, requested: string, read: CornerstoneEvidenceReader,
  options: { expectedTitle?: string; now?: Date } = {}): Promise<Row> {
  try { return parseCornerstonePosting(html, requested, options.expectedTitle); }
  catch (error) {
    // Never replace contradictory, duplicated or malformed structured evidence.
    if (!(error instanceof Error) || error.message !== 'Cornerstone exact posting lacks unique structured evidence'
      || load(html)('script[type="application/ld+json"]').length !== 0) {
      throw new AtsDetailResponseError(error instanceof Error ? error.message : String(error), error);
    }
  }
  const identity = expandedPostingIdentity(requested)!;
  const config = expandedConfig('cornerstone', identity.slug, html);
  const [, site] = identity.slug.split('::');
  const origin = new URL(requested).origin;
  requireEvidence(origin.startsWith('https://'), 'public evidence requires HTTPS');
  const pageTitles = load(html)('meta[property="og:title"]');
  const pageTitle = text(pageTitles.attr('content'));
  requireEvidence(pageTitles.length === 1 && pageTitle && (!options.expectedTitle || pageTitle === options.expectedTitle), 'page title disagrees with retained posting');
  const json = async (path: string): Promise<unknown> => {
    const target = new URL(path, origin).href;
    const response = await read(target, { redirect: 'error', headers: { Accept: 'application/json', Authorization: `Bearer ${config.token}` } });
    if (!response.ok) throw new AtsDetailHttpError(response.status);
    requireEvidence(!response.url || response.url === target, 'public service changed response identity');
    const body = await readCornerstoneBody(response);
    try { return JSON.parse(body); }
    catch (error) { throw new AtsDetailResponseError('Cornerstone public service returned invalid JSON', error); }
  };

  // Anonymous Apply Now status binds public availability to this site and ID.
  const availability = legacyFields(await json(`/Services/API/ATS/CareerSite/${site}/JobRequisition/${identity.id}/GetRequisitionApplyStatus`));
  if (availability.applyStatus !== 2) throw new AtsDetailResponseError('Cornerstone exact posting is not publicly available to apply', undefined, 'posting_unavailable');
  const published = row(await json(`/services/x/career-site/v1/requisition/${identity.id}`));
  requireEvidence(published.status === 0, 'posting publication response did not succeed');
  const postings = rows(row(published.data).postings).filter(post => String(post.careerSiteId) === site);
  requireEvidence(postings.length === 1, 'requisition has no unique publication on this career site');
  const posting = postings[0], postingUrl = text(posting.postingUrl);
  let publishedUrl: URL;
  try { publishedUrl = new URL(postingUrl); }
  catch { throw new AtsDetailResponseError('Cornerstone published URL is invalid'); }
  const postedIdentity = expandedPostingIdentity(postingUrl);
  const publishedSlug = expandedBoardSlug('cornerstone', postingUrl);
  const classicId = /^\/ats\/careersite\/jobdetails\.aspx$/i.test(publishedUrl.pathname)
    && publishedUrl.searchParams.getAll('id').length === 1 ? publishedUrl.searchParams.get('id') : null;
  // Publication URLs normally omit language even on translated career sites.
  requireEvidence(publishedUrl.origin === origin && (postedIdentity?.id || classicId) === identity.id
    && publishedSlug?.split('::').slice(0, 2).join('::') === identity.slug.split('::').slice(0, 2).join('::')
    && ['id', 'site', 'c', 'lang'].every(key => publishedUrl.searchParams.getAll(key).length <= 1)
    && (!publishedUrl.searchParams.has('id') || publishedUrl.searchParams.get('id') === identity.id)
    && (!publishedUrl.searchParams.has('lang') || publishedUrl.searchParams.get('lang')?.toLowerCase() === config.cultureName?.toLowerCase()),
  'published URL disagrees with the exact tenant, site or requisition');
  const now = options.now || new Date();
  // Provider dates are local calendar values without offsets. Allow the adjacent
  // UTC days and let the exact site's Apply Now response own the boundary.
  const earliest = new Date(+now - 86400_000).toISOString().slice(0, 10);
  const latest = new Date(+now + 86400_000).toISOString().slice(0, 10);
  const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : '';
  requireEvidence(date(posting.startDate) && date(posting.startDate) <= latest
    && (posting.endDate === null || date(posting.endDate) && date(posting.endDate) >= earliest), 'posting dates do not establish current publication');

  const details = row(await json(`/services/x/job-requisition/v2/requisitions/${identity.id}/jobDetails?cultureId=${config.cultureId}`));
  requireEvidence(details.status === 0, 'job details did not succeed');
  const detail = row(details.data);
  const cultures = cultureIds(detail.availableCultures);
  // The public client can request its UI language while the posting only has
  // an authored default language. Read that explicitly published fallback.
  const culture = cultures.includes(config.cultureId!) ? config.cultureId : detail.defaultCultureId;
  requireEvidence(text(detail.displayTitle) === pageTitle && detail.allowApply === true
    && detail.requisitionStatusId === 2 && Number.isSafeInteger(culture) && cultures.includes(culture as number),
  'job details changed title, availability or language');
  const fields = legacyFields(await json(`/Services/API/ATS/CareerSite/${site}/JobRequisitions/${identity.id}?useMobileAd=false&cultureId=${culture}`));
  requireEvidence(String(fields.id) === identity.id && text(fields.title) === pageTitle
    && text(fields.reqId) && text(fields.reqId) === text(detail.ref), 'job ad changed requisition, reference or title');
  const description = typeof fields.ad === 'string' ? fields.ad.trim() : '';
  requireEvidence(description && text(load(description).text()).length >= 80
    && !/^Description too Large\./i.test(description), 'job ad lacks a full description');
  const company = cornerstoneJobAdEmployer(description, requested, pageTitle, text(fields.reqId));
  if (!company) throw new AtsDetailResponseError('Cornerstone exact job ad has no unambiguous employer statement', undefined, 'employer_unverified');
  const locations = [row(detail.primaryLocation), ...rows(detail.additionalLocations)]
    .map(cornerstoneWorksiteLocation).filter(Boolean);
  return { title: pageTitle, company, description, location: [...new Set(locations)].join('; '), url: requested };
}

function cultureIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || !value.every(v => Number.isSafeInteger(v) && v > 0)) throw new AtsDetailResponseError('Cornerstone detail languages are invalid');
  return value as number[];
}
