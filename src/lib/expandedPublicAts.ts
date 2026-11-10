import { load } from 'cheerio';
import { futureAtsCandidateUrl } from './atsDiscoveryBacklog';
import { publishedEmployerName } from './publicAtsEmployer';

export const EXPANDED_PUBLIC_ATS = ['cornerstone', 'hireology', 'polymer'] as const;
export type ExpandedPublicAts = typeof EXPANDED_PUBLIC_ATS[number];
export const isExpandedPublicAts = (platform: string): platform is ExpandedPublicAts => (EXPANDED_PUBLIC_ATS as readonly string[]).includes(platform);
export type ExpandedAtsConfig = { company: string; token?: string; apiOrigin?: string; cultureId?: number; cultureName?: string; canonicalSlug?: string; tokenExpiresAt?: number };
type Row = Record<string, unknown>;
export type ExpandedAtsListing = { jobs: Row[]; metadata: Row; total: number | null };
const value = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const atom = /^[a-z0-9][a-z0-9_-]*$/i;
const countriesInEnglish = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (country: string): string => /^[a-z]{2}$/i.test(country) ? countriesInEnglish.of(country.toUpperCase()) || country : country;
const object = (v: unknown): Row => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Public ATS response must be an object'); return v as Row; };
const rows = (v: unknown): Row[] => { if (!Array.isArray(v)) throw Error('Public ATS response must contain a job array'); return v.map(object); };
const integer = (v: unknown): number => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw Error('Public ATS count is invalid'); return v as number; };
const id = (v: unknown): string => { const s = typeof v === 'number' ? String(integer(v)) : value(v); if (!/^[1-9]\d*$/.test(s)) throw Error('Public ATS posting ID is invalid'); return s; };

/** Parse only literal JSON; career-page JavaScript is never evaluated. */
function assignedJson(html: string, name: string): Row {
  const match = new RegExp(`\\b${name}\\s*=\\s*\\{`).exec(html);
  if (!match) throw Error('Public career-page configuration is missing');
  const start = match.index + match[0].lastIndexOf('{');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return object(JSON.parse(html.slice(start, i + 1)));
  }
  throw Error('Public career-page configuration is incomplete');
}

export function expandedBoardSlug(platform: ExpandedPublicAts, input: string): string | null {
  const candidate = futureAtsCandidateUrl(platform, input);
  if (!candidate) return null;
  const url = new URL(candidate);
  if (platform === 'cornerstone') {
    const site = /\/ux\/ats\/careersite\/([1-9]\d*)\/home$/i.exec(url.pathname)?.[1];
    if (!site) return null;
    const original = new URL(input);
    const corp = original.searchParams.get('c');
    if (corp && corp.toLowerCase() !== url.hostname.split('.')[0]) return null;
    const lang = original.searchParams.get('lang') || 'default';
    return lang === 'default' || /^[a-z]{2}-[a-z]{2}$/i.test(lang) ? `${url.hostname}::${site}::${lang}` : null;
  }
  if (platform === 'hireology' && url.hostname.endsWith('.hireology.careers')) return `site::${url.hostname}`;
  return decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] || '') || null;
}

export function expandedBoardUrl(platform: ExpandedPublicAts, slug: string): string {
  let url: string;
  if (platform === 'cornerstone') {
    const [host, site, lang, extra] = slug.split('::');
    if (extra || !/^[a-z0-9-]+\.csod\.com$/.test(host) || !/^[1-9]\d*$/.test(site || '') || !(lang === 'default' || /^[a-z]{2}-[a-z]{2}$/i.test(lang || ''))) throw Error('Invalid Cornerstone board');
    url = `https://${host}/ux/ats/careersite/${site}/home${lang === 'default' ? '' : `?lang=${lang}`}`;
  } else if (platform === 'hireology' && slug.startsWith('site::')) {
    const host = slug.slice(6);
    if (!/^[a-z0-9-]+\.hireology\.careers$/.test(host)) throw Error('Invalid Hireology alias');
    url = `https://${host}/`;
  } else {
    if (!atom.test(slug)) throw Error('Invalid public ATS tenant');
    url = `https://${platform === 'polymer' ? 'jobs.polymer.co' : 'careers.hireology.com'}/${slug}`;
  }
  if (expandedBoardSlug(platform, url) !== slug) throw Error('Public ATS board identity mismatch');
  return url;
}

export function expandedConfig(platform: ExpandedPublicAts, slug: string, html: string, landed?: string): ExpandedAtsConfig {
  expandedBoardUrl(platform, slug);
  if (landed && expandedBoardSlug(platform, landed) !== slug) throw Error('Public career page changed board identity');
  if (platform === 'polymer') return { company: '' };
  const data = assignedJson(html, platform === 'cornerstone' ? 'csod\\.context' : 'startingData');
  const token = value(data[platform === 'cornerstone' ? 'token' : 'apiToken']);
  if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error('Public anonymous read token is missing');
  let claims: Row;
  try { claims = object(JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))); }
  catch { throw Error('Public anonymous read token is malformed'); }
  const expires = typeof claims.exp === 'number' ? claims.exp * 1000 - 30_000 : Date.now() + 10 * 60_000;
  if (expires <= Date.now()) throw Error('Public anonymous read token has expired');
  if (platform === 'hireology') {
    const canonicalSlug = value(data.careersPath);
    if (!atom.test(canonicalSlug) || (!slug.startsWith('site::') && canonicalSlug !== slug)
      || value(data.apiUrl) !== 'https://api.hireology.com/v2' || value(data.appUrl) !== 'https://careers.hireology.com') throw Error('Hireology career configuration identity mismatch');
    return { company: '', token, tokenExpiresAt: expires, ...(canonicalSlug !== slug ? { canonicalSlug } : {}) };
  }
  const [host, site, lang] = slug.split('::');
  const route = assignedJson(html, 'csodPlayerRouteInfo');
  const cloud = new URL(value(object(data.endpoints).cloud));
  if (value(data.corp).toLowerCase() !== host.split('.')[0] || value(claims.corp).toLowerCase() !== host.split('.')[0]
    || String(route.cid) !== site || typeof data.user !== 'number' || data.user >= 0
    || cloud.protocol !== 'https:' || !/^[a-z0-9-]+\.api\.csod\.com$/.test(cloud.hostname)
    || cloud.username || cloud.password || cloud.port || cloud.pathname !== '/' || cloud.search || cloud.hash
    || !Number.isSafeInteger(data.cultureID) || (lang !== 'default' && value(data.cultureName).toLowerCase() !== lang.toLowerCase())) throw Error('Cornerstone career configuration identity mismatch');
  return { company: '', token, apiOrigin: cloud.origin, cultureId: data.cultureID as number, cultureName: value(data.cultureName), tokenExpiresAt: expires };
}

export function polymerPageRequest(slug: string, page = 1): { url: string; init: RequestInit } {
  expandedBoardUrl('polymer', slug);
  if (!Number.isSafeInteger(page) || page < 1) throw Error('Invalid Polymer page');
  return { url: `https://api.polymer.co/v1/hire/organizations/${slug}/jobs?page=${page}`, init: { headers: { Accept: 'application/json' } } };
}

export function expandedRequest(platform: ExpandedPublicAts, slug: string, offset = 0, config?: ExpandedAtsConfig): { url: string; init: RequestInit } {
  const board = expandedBoardUrl(platform, slug);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 20 !== 0 || platform === 'polymer' && offset !== 0) throw Error('Invalid public ATS listing offset');
  if (platform === 'polymer') return polymerPageRequest(slug);
  // Callers resolve public page configuration before dispatching this request.
  if (!config?.token) return { url: board, init: {} };
  const headers = { Accept: 'application/json', Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  if (platform === 'hireology') return { url: `https://api.hireology.com/v2/public/careers/${config.canonicalSlug || slug}?page=${offset / 20 + 1}&page_size=20`, init: { headers } };
  if (!config.apiOrigin || !/^https:\/\/[a-z0-9-]+\.api\.csod\.com$/.test(config.apiOrigin)) throw Error('Cornerstone regional API is unverified');
  const site = Number(slug.split('::')[1]);
  return { url: `${config.apiOrigin}/rec-job-search/external/jobs`, init: { method: 'POST', headers, body: JSON.stringify({
    careerSiteId: site, careerSitePageId: site, pageNumber: offset / 20 + 1, pageSize: 20,
    cultureId: config.cultureId, cultureName: config.cultureName, searchText: '', states: [], countryCodes: [], cities: [],
    placeID: '', radius: null, postingsWithinDays: null, customFieldCheckboxKeys: [], customFieldDropdowns: [], customFieldRadios: [],
  }) } };
}

function location(places: Row[]): string {
  return places.map(place => [place.city, place.state, place.country].map(value).filter(Boolean).join(', ')).filter(Boolean).join('; ');
}

function hireologyCompensation(input: unknown): string {
  const comp = object(input || {});
  const positive = (v: unknown) => Number.isFinite(Number(v)) && Number(v) > 0 ? String(v) : '';
  const amount = comp.is_comp_range === true ? [positive(comp.comp_range_min), positive(comp.comp_range_max)].filter(Boolean).join(' - ') : positive(comp.comp_single_amount);
  return amount ? [amount, value(comp.comp_period), value(comp.comp_frequency)].filter(Boolean).join(' ') : '';
}

export function polymerLocation(job: Row): string {
  const office = value(job.display_location) || [job.city, job.state_region, job.country].map(value).filter(Boolean).join(', ');
  if (value(job.remoteness_pretty).toLowerCase() !== 'remote') return [office, value(job.remoteness_pretty)].filter(Boolean).join(' - ');
  const countries = Array.isArray(job.remote_restriction_country_list) ? job.remote_restriction_country_list.map(value).filter(Boolean).map(countryName) : [];
  const scope = job.remote_restriction_country_residency_is_required === true ? countries.join(', ') || office
    : job.remote_restriction_country_residency_is_required === false ? 'Worldwide' : office;
  const restrictions = [job.remote_restriction_city_google_place_id && value(job.remote_restriction_city),
    job.remote_restriction_overlap_hours_is_required === true && `required overlap ${job.remote_restriction_overlap_hours} hours`].filter(Boolean);
  return `Remote${scope ? ` (${scope})` : ''}${restrictions.length ? `; ${restrictions.join('; ')}` : ''}`;
}

function polymerPage(slug: string, payload: unknown, page: number): ExpandedAtsListing {
  const data = object(payload), meta = object(data.meta), list = rows(data.items);
  const count = integer(meta.count), pages = integer(meta.total);
  if (meta.page !== page || typeof meta.is_last !== 'boolean' || meta.is_first !== (page === 1)
    || (meta.next_page !== null && meta.next_page !== page + 1)
    || (count === 0 ? page !== 1 || list.length !== 0 || pages !== 0 || meta.next_page !== null
      : !pages || page > pages || !list.length || (meta.is_last !== (page === pages)) || (page < pages) !== (meta.next_page === page + 1))) throw Error('Polymer pagination identity mismatch');
  const company = publishedEmployerName(meta.organization_name);
  if (!company) throw Error('Polymer feed has no verified employer');
  const seen = new Set<string>();
  const jobs = list.map(job => {
    const postingId = id(job.id), title = value(job.title), url = value(job.job_post_url);
    if (!title || seen.has(postingId) || expandedBoardSlug('polymer', url) !== slug || new URL(url).pathname !== `/${slug}/${postingId}`
      || publishedEmployerName(job.organization_name) !== company) throw Error('Polymer posting identity mismatch');
    seen.add(postingId);
    return { id: `${slug}::${postingId}`, publicAtsPostingId: postingId, title, company, url, description: '',
      location: polymerLocation(job), createdAt: value(job.published_at), postedCompensation: value(job.salary_pretty) };
  });
  if (jobs.length > count) throw Error('Polymer count disagrees with its jobs');
  return { jobs, total: count, metadata: { name: company, polymerNextPage: meta.next_page, polymerPages: pages } };
}

export function parseExpandedListing(platform: ExpandedPublicAts, slug: string, payload: unknown, config: ExpandedAtsConfig = { company: '' }, offset = 0): ExpandedAtsListing {
  if (platform === 'polymer') return polymerPage(slug, payload, 1);
  expandedBoardUrl(platform, slug);
  const data = object(payload), page = platform === 'cornerstone' ? object(data.data) : data;
  if (platform === 'cornerstone' && data.status !== 'Success') throw Error('Cornerstone search did not succeed');
  const list = rows(platform === 'cornerstone' ? page.requisitions : data.data);
  const total = integer(platform === 'cornerstone' ? page.totalCount : data.count);
  if (platform === 'hireology' && (data.page !== offset / 20 + 1 || data.page_size !== 20)) throw Error('Hireology returned a repeated page');
  const hasMore = offset + list.length < total;
  if (list.length > 20 || offset + list.length > total || hasMore && list.length !== 20) throw Error('Public ATS listing count and page disagree');
  const seen = new Set<string>();
  const jobs = list.map(job => {
    const postingId = id(platform === 'cornerstone' ? job.requisitionId : job.id);
    const title = value(platform === 'cornerstone' ? job.displayJobTitle : job.name);
    const description = value(platform === 'cornerstone' ? job.externalDescription : job.job_description);
    if (!title || !description || seen.has(postingId)) throw Error('Public ATS posting is incomplete or repeated');
    seen.add(postingId);
    if (platform === 'hireology' && (job.blind_posted === true || job.status !== 'Open')) throw Error('Hireology posting is not publicly attributable and open');
    // An exact requisition proves only its own employer, not its neighbours.
    const company = platform === 'cornerstone' ? '' : publishedEmployerName(object(job.organization).name);
    if (platform === 'hireology' && !company) throw Error('Hireology posting has no verified employer');
    const url = platform === 'cornerstone' ? `${expandedBoardUrl(platform, slug).split('?')[0]}/requisition/${postingId}${slug.split('::')[2] === 'default' ? '' : `?lang=${slug.split('::')[2]}`}` : value(job.career_site_url);
    if (platform === 'hireology' && (expandedBoardSlug(platform, url) !== (config.canonicalSlug || slug)
      || new URL(url).pathname !== `/${config.canonicalSlug || slug}/${postingId}/description`)) throw Error('Hireology posting URL changed identity');
    const places = rows(job.locations);
    return { id: `${slug}::${postingId}`, publicAtsPostingId: postingId, title, company, description, url,
      location: `${location(places)}${job.remote === true ? ' (Remote)' : ''}`,
      ...(platform === 'hireology' ? { postedCompensation: hireologyCompensation(job.compensation) } : {}) };
  });
  return { jobs, metadata: { name: platform === 'cornerstone' ? '' : config.company, listingHasMore: hasMore }, total };
}

export function expandedPostingIdentity(input: string): { platform: ExpandedPublicAts; slug: string; id: string } | null {
  for (const platform of EXPANDED_PUBLIC_ATS) {
    const slug = expandedBoardSlug(platform, input);
    if (!slug) continue;
    const url = new URL(input);
    const postingId = platform === 'cornerstone' ? /\/requisition\/([1-9]\d*)\/?$/i.exec(url.pathname)?.[1]
      : platform === 'polymer' ? /^\/[^/]+\/([1-9]\d*)\/?$/.exec(url.pathname)?.[1]
        : /^\/[^/]+\/([1-9]\d*)\/description\/?$/.exec(url.pathname)?.[1];
    if (postingId) return { platform, slug, id: postingId };
  }
  return null;
}

/** Country-only structured addresses can omit the posting's authored location header. */
function cornerstoneDescriptionLocation(description: string): string | null {
  const $ = load(description);
  $('script, style').remove();
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4').append('\n');
  const lines = $.root().text().split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const locations = new Set<string>();
  for (const line of lines.slice(0, 30)) {
    const candidate = /^(?:job |work )?locations?\s*:\s*([^:]{1,160})$/i.exec(line)?.[1]?.trim();
    if (candidate && !/https?:\/\/|^(?:unknown|not specified|n\/a)$/i.test(candidate)) locations.add(candidate);
  }
  return locations.size === 1 ? [...locations][0] : null;
}

export function parseCornerstonePosting(html: string, requested: string, expectedTitle?: string): Row {
  const identity = expandedPostingIdentity(requested);
  if (!identity || identity.platform !== 'cornerstone') throw Error('Invalid Cornerstone posting URL');
  expandedConfig('cornerstone', identity.slug, html);
  const $ = load(html), route = assignedJson(html, 'csodPlayerRouteInfo');
  const routeInfo = object(route.routeInfo);
  if (String(routeInfo.reqid) !== identity.id) throw Error('Cornerstone exact posting route mismatch');
  const records = $('script[type="application/ld+json"]').toArray().flatMap(node => {
    try { const parsed = JSON.parse($(node).text()); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return []; }
  }).filter((record: Row) => record?.['@type'] === 'JobPosting');
  if (records.length !== 1) throw Error('Cornerstone exact posting lacks unique structured evidence');
  const job = records[0], title = value(job.Title || job.title), company = publishedEmployerName(object(job.HiringOrganization || job.hiringOrganization).Name || object(job.HiringOrganization || job.hiringOrganization).name);
  const description = value(job.Description || job.description);
  if (!company || !title || !description || expectedTitle && title !== expectedTitle) throw Error('Cornerstone exact posting metadata mismatch');
  const places = rows(Array.isArray(job.jobLocation) ? job.jobLocation : job.jobLocation ? [job.jobLocation] : []);
  const addresses = places.map(place => object(place.Address || place.address || {}));
  const countryOf = (address: Row): string => {
    const country = address.addressCountry;
    return value(typeof country === 'string' ? country : country ? object(country).Name || object(country).name : '');
  };
  let postingLocation = addresses.map(address => {
    const country = countryOf(address);
    return [address.addressLocality, address.addressRegion, country].map(value).filter(Boolean).join(', ');
  }).filter(Boolean).join('; ');
  if (!addresses.some(address => value(address.addressLocality) || value(address.addressRegion))) {
    const authoredLocation = cornerstoneDescriptionLocation(description);
    if (authoredLocation) {
      const countries = [...new Set(addresses.map(countryOf).filter(Boolean))];
      const country = countries.length === 1 ? countries[0] : '';
      const alreadyNamed = country && authoredLocation.split(/[,;()]/).some(part =>
        [country.toLowerCase(), countryName(country).toLowerCase()].includes(part.trim().toLowerCase()));
      postingLocation = country && !alreadyNamed ? `${authoredLocation}, ${country}` : authoredLocation;
    }
  }
  return { company, title, description, location: postingLocation };
}

export async function completeExpandedListing(platform: ExpandedPublicAts, slug: string, feed: ExpandedAtsListing,
  read: (url: string, init?: RequestInit) => Promise<{ url: string; body: string }>): Promise<ExpandedAtsListing> {
  if (platform !== 'polymer') return feed;
  const jobs = [...feed.jobs], seen = new Set(jobs.map(job => job.id));
  let next = feed.metadata.polymerNextPage, pages = 1, bytes = 0;
  while (next !== null) {
    if (!Number.isSafeInteger(next) || next !== pages + 1 || pages >= 100) throw Error('Polymer continuation is invalid');
    const request = polymerPageRequest(slug, next as number), response = await read(request.url, request.init);
    if (response.url && new URL(response.url).href !== request.url) throw Error('Polymer listing redirected away from its exact identity');
    bytes += new TextEncoder().encode(response.body).length;
    if (bytes > 5 * 1024 * 1024) throw Error('Polymer complete feed exceeds its bounded response allowance');
    const continuation = polymerPage(slug, JSON.parse(response.body), next as number);
    if (continuation.total !== feed.total || continuation.metadata.name !== feed.metadata.name) throw Error('Polymer catalogue changed during pagination');
    for (const job of continuation.jobs) { if (seen.has(job.id)) throw Error('Polymer returned a repeated page'); seen.add(job.id); jobs.push(job); }
    pages++; next = continuation.metadata.polymerNextPage;
  }
  if (jobs.length !== feed.total) throw Error('Polymer feed ended before its reported count');
  return { jobs, metadata: { name: feed.metadata.name }, total: feed.total };
}

export function polymerDetailRequest(input: string): string | null {
  const identity = expandedPostingIdentity(input);
  return identity?.platform === 'polymer' ? `https://api.polymer.co/v1/hire/organizations/${identity.slug}/jobs/${identity.id}` : null;
}

export function parsePolymerDetail(payload: unknown, requested: string): Row {
  const identity = expandedPostingIdentity(requested), job = object(payload);
  const published = expandedPostingIdentity(value(job.job_post_url));
  if (!identity || identity.platform !== 'polymer' || published?.platform !== 'polymer' || published.slug !== identity.slug || published.id !== identity.id || id(job.id) !== identity.id
    || !value(job.title) || !value(job.description) || !publishedEmployerName(job.organization_name) || job.archived_at) throw Error('Polymer exact detail identity mismatch');
  return { title: value(job.title), company: publishedEmployerName(job.organization_name), description: value(job.description), location: polymerLocation(job), compensation: value(job.salary_pretty) || null };
}
