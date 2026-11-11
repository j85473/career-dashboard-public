import { load } from 'cheerio';

// Explicitly verified employer-host / public API organization pairs. A vanity
// hostname alone must never be converted into an invented vendor tenant.
const boards: Record<string, { host: string; organization: string; company: string; branding?: string; scoutOrgId: number; portals: string[]; home: string; postingPath: string; levelIsLocation?: boolean;
  organizationSuppliesEmployer?: boolean; upstreamOracleSite?: string }> = {
  deltek: { host: 'careers.deltek.com', organization: 'd78c5717-c840-461e-8f42-7e005f1a8068', company: 'Deltek', scoutOrgId: 2458, portals: ['Kenexa'], home: '/', postingPath: '/job', levelIsLocation: true },
  hgv: { host: 'careers.hgv.com', organization: '66818394-0397-4ae2-9aff-2893667aba0b', company: 'Hilton Grand Vacations', scoutOrgId: 2012, portals: ['orc_mule_en'], home: '/', postingPath: '/job-en',
    organizationSuppliesEmployer: true, upstreamOracleSite: 'https://efuq.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/HiltonGrandVacations/job/' },
  victoriassecret: { host: 'careers.victoriassecret.com', organization: '382ab4db-03e8-40cc-b413-51539aca9954', company: 'Victorias Secret & Co', branding: "Victoria's Secret", scoutOrgId: 2391, portals: ['SuccesFactors', 'Taleo'], home: '/en/', postingPath: '/en/job' },
};
export const SYMPHONY_DISCOVERY_PATTERNS = Object.values(boards).map(value => value.host + '/*');
export const SYMPHONY_PAGE_SIZE = 20;
function board(slug: string) {
  const result = Object.hasOwn(boards, slug) ? boards[slug] : undefined;
  if (!result) throw new Error('Unverified Symphony Talent board identity');
  return result;
}

export function symphonyBoardSlugFromUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    const match = Object.entries(boards).find(([, b]) => b.host === u.hostname);
    if (!match) return null;
    const b = match[1], suffix = u.pathname.slice(b.postingPath.length);
    if (u.pathname !== b.home && u.pathname !== b.home.replace(/\/$/, '')
      && !(u.pathname.startsWith(b.postingPath + '/') && /^\/[1-9]\d*(?:\/[^/]+)?\/?$/.test(suffix))) return null;
    return match[0];
  } catch { return null; }
}

export function symphonyBoardUrl(slug: string): string { const b = board(slug); return `https://${b.host}${b.home}`; }

export function symphonyPostingIdentity(value: string): { slug: string; id: string } | null {
  const slug = symphonyBoardSlugFromUrl(value);
  if (!slug) return null;
  const id = new URL(value).pathname.slice(board(slug).postingPath.length + 1).split('/')[0];
  return id && /^[1-9]\d*$/.test(id) ? { slug, id } : null;
}

export function symphonyPostingRequest(value: string): string | null {
  const identity = symphonyPostingIdentity(value);
  if (!identity) return null;
  const url = new URL('https://jobsapi-google.m-cloud.io/api/job/get');
  url.search = new URLSearchParams({ companyName: `companies/${board(identity.slug).organization}`, id: identity.id }).toString();
  return url.href;
}

export function symphonyBoardRequest(slug: string, offset = 0): { url: string; init: RequestInit } {
  const b = board(slug);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % SYMPHONY_PAGE_SIZE) throw new Error('Invalid Symphony listing offset');
  const url = new URL('https://jobsapi-google.m-cloud.io/api/job/search');
  url.search = new URLSearchParams({ companyName: `companies/${b.organization}`, pageSize: String(SYMPHONY_PAGE_SIZE),
    offset: String(offset), customAttributeFilter: b.portals.map(portal => `ats_portalid=${JSON.stringify(portal)}`).join(' OR '), orderBy: 'posting_publish_time desc' }).toString();
  return { url: url.href, init: { headers: { Accept: 'application/json' }, cache: 'no-store' } };
}

/** Verify the public site still publishes the organization we are about to query. */
export function parseSymphonyConfig(slug: string, html: string, landedUrl?: string): { company: string } {
  const b = board(slug);
  if (landedUrl && symphonyBoardSlugFromUrl(landedUrl) !== slug) throw new Error('Symphony career page redirected away from its board');
  const $ = load(html);
  const compact = html.replace(/\\\//g, '/');
  const publicOptions = $('script').toArray().flatMap(element => {
    const source = $(element).text().replace(/\\\//g, '/');
    return [...source.matchAll(/\b(?:var\s+)?cws_opts\s*=\s*(\{[^\r\n]*?\})\s*;/g)].map(match => {
      try { return JSON.parse(match[1]) as Record<string, unknown>; } catch { return null; }
    });
  });
  // Read the site's API setter rather than accepting an address mentioned in
  // arbitrary page text, a foreign URL's path, or a query parameter.
  const apiValues = $('script').toArray().flatMap(element =>
    [...$(element).text().replace(/\\\//g, '/').matchAll(/\bCWS\.jobs\.set_api\(\s*(["'])([^"'\\\r\n]*)\1\s*\)/g)].map(match => match[2]));
  const apiValid = (value: string) => {
    try {
      const api = new URL(value.trim());
      return api.protocol === 'https:' && api.hostname === 'jobsapi-google.m-cloud.io'
        && !api.port && !api.username && !api.password && api.pathname === '/api/' && !api.search && !api.hash;
    } catch { return false; }
  };
  const verifiedApi = apiValues.length > 0 && apiValues.every(apiValid);
  const verifiedOptions = publicOptions.length === 1 && publicOptions.every(options => options
    && options.org === `companies/${b.organization}` && String(options.smartPost_org) === String(b.scoutOrgId)
    && typeof options.api === 'string' && apiValid(options.api) && options.job_detail_path === b.postingPath);
  if (!compact.includes(`companies/${b.organization}`) || !(verifiedApi || verifiedOptions)
    || apiValues.some(value => !apiValid(value)) || publicOptions.length > 0 && !verifiedOptions
    || !$.text().includes(b.branding || b.company)) throw new Error('Symphony public career configuration identity mismatch');
  return { company: b.company };
}

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Symphony listing schema expected an object');
  return value as Row;
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** HGV publishes some records using its own Oracle requisition URL. The
 * verified public site's configured detail route still serves the Symphony ID. */
function symphonyListingUrl(slug: string, job: Row, id: string): string {
  const b = board(slug), published = text(job.url);
  const identity = symphonyPostingIdentity(published);
  if (identity?.slug === slug && identity.id === id && new URL(published).protocol === 'https:') return published;
  if (b.upstreamOracleSite && /^[1-9]\d*$/.test(text(job.ref))) {
    const expected = b.upstreamOracleSite + text(job.ref);
    if (published === expected || published === expected + '/') return `https://${b.host}${b.postingPath}/${id}/`;
  }
  throw new Error('Symphony listing posting identity mismatch');
}

export function parseSymphonyListing(slug: string, payload: unknown, offset = 0): { jobs: Row[]; metadata: Row; total: number } {
  symphonyBoardRequest(slug, offset);
  const b = board(slug), data = row(payload);
  if (!Number.isSafeInteger(data.totalHits) || (data.totalHits as number) < 0 || !Array.isArray(data.searchResults)) throw new Error('Symphony listing schema has invalid results or total');
  const total = data.totalHits as number, results = data.searchResults;
  const hasMore = offset + results.length < total;
  if (results.length > SYMPHONY_PAGE_SIZE || offset + results.length > total || hasMore && results.length !== SYMPHONY_PAGE_SIZE
    || !hasMore && data.nextPageToken != null) throw new Error('Symphony listing total and continuation disagree');
  const ids = new Set<string>();
  const jobs = results.map(value => {
    const j = row(row(value).job), id = typeof j.id === 'number' && Number.isSafeInteger(j.id) && j.id > 0 ? String(j.id) : '';
    if (!id || ids.has(id)) throw new Error('Symphony listing has missing or repeated posting identity');
    ids.add(id);
    const title = text(j.title), description = text(j.description);
    // This exception is bound to HGV's reviewed organization and portal, never
    // inferred from a tenant slug. A conflicting employer remains an error.
    const employerMatches = j.company_name === b.company
      || b.organizationSuppliesEmployer && j.company_name == null;
    if (j.scout_orgid !== b.scoutOrgId || !employerMatches || !b.portals.includes(String(j.ats_portalid))) {
      throw new Error('Symphony listing posting identity mismatch');
    }
    const url = symphonyListingUrl(slug, j, id);
    if (!title || !description || !text(j.ref)) throw new Error('Symphony listing has no title, description or requisition');
    // Deltek's display location carries remote scope. The primary API office
    // can be headquarters even for a US-wide remote role; never substitute it.
    const location = (b.levelIsLocation ? text(j.level) : '') || [text(j.primary_city), text(j.primary_state), text(j.primary_country)].filter(Boolean).join(', ') || 'Unknown Location';
    return { id: `${slug}::${id}`, publicAtsPostingId: id, title, description, company: b.company, url, location,
      symphonyRequisition: text(j.ref), symphonyApplyUrl: text(j.seo_url),
      ...(url !== text(j.url) ? { symphonySourceUrl: text(j.url) } : {}), postedTravel: text(j.travel) || null };
  });
  return { jobs, total, metadata: { name: b.company, listingHasMore: hasMore, symphonyListingOffset: offset } };
}
