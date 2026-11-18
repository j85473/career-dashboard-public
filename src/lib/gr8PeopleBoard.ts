import { load } from 'cheerio';
import { AtsTemporaryUnavailableError } from './atsTemporaryFailure';
import { extractStructuredBaseCompensation } from './postedCompensation';
import { publishedEmployerName } from './publicAtsEmployer';

export const GR8_PEOPLE_PAGE_SIZE = 40;
export const GR8_PEOPLE_DISCOVERY_PATTERNS = ['*.gr8people.com/jobs*', 'careers.teradata.com/jobs*'];

const teradataHost = 'careers.teradata.com';
const nonPublicTenant = /^(?:www\d*|api|apps?|assets|cdn|dev(?:elopers?)?|docs|help|services|status|support|t|test|demo|training)(?:-|$)|internal(?:-|$)/i;
const publicJobsPath = /^\/jobs(?:\/([1-9]\d*)(?:\/[^/]+)?)?\/?$/;
const nonOpenStatuses = new Set(['CANCELED', 'CLOSED', 'ON_HOLD']);

export function gr8PeopleBoardSlugFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !publicJobsPath.test(url.pathname)) return null;
    const tenant = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.gr8people\.com$/.exec(url.hostname)?.[1];
    return url.hostname === teradataHost || (tenant && !nonPublicTenant.test(tenant)) ? url.hostname : null;
  } catch {
    return null;
  }
}

export function gr8PeoplePostingIdentity(value: string): { host: string; key: string } | null {
  const host = gr8PeopleBoardSlugFromUrl(value);
  if (!host) return null;
  const key = publicJobsPath.exec(new URL(value).pathname)?.[1];
  return key ? { host, key } : null;
}

export function gr8PeopleBoardUrl(slug: string): string {
  const url = `https://${slug}/jobs`;
  if (gr8PeopleBoardSlugFromUrl(url) !== slug) throw new Error('Invalid GR8 People board identity');
  return url;
}

export function isGr8PeoplePublicBoardPage(slug: string, landedUrl: string, html: string): boolean {
  if (landedUrl.replace(/\/$/, '') !== gr8PeopleBoardUrl(slug)) return false;
  const $ = load(html);
  try {
    const data = JSON.parse($('script#__NEXT_DATA__[type="application/json"]').text());
    return data?.page === '/jobs' && data?.assetPrefix === 'https://assets.gr8people.com/builds/app-career-site';
  } catch {
    return false;
  }
}

export function gr8PeopleListingRequest(slug: string, offset: number): { url: string; init: RequestInit } {
  const boardUrl = new URL(gr8PeopleBoardUrl(slug));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % GR8_PEOPLE_PAGE_SIZE !== 0) {
    throw new Error('Invalid GR8 People listing offset');
  }
  return {
    url: new URL('/graphql', boardUrl).href,
    init: {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Apollo-Require-Preflight': 'true',
        Origin: boardUrl.origin,
        Referer: boardUrl.href,
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        operationName: 'searchJobs',
        variables: { start: offset, first: GR8_PEOPLE_PAGE_SIZE, filters: {} },
        extensions: { trustedDocument: { id: 'search-jobs' } },
      }),
    },
  };
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Missing and non-open nodes occupy search positions without becoming intake items. */
export function atsListingPositionsConsumed(platform: string, metadata: unknown, jobCount: number): number {
  if (platform !== 'gr8people') return jobCount;
  const slots = record(metadata).listingUnavailableSlots;
  if (!Array.isArray(slots) || !slots.length) return jobCount;
  const positions = jobCount + slots.length;
  if (positions > GR8_PEOPLE_PAGE_SIZE || new Set(slots).size !== slots.length
    || slots.some(slot => !Number.isSafeInteger(slot) || slot < 0 || slot >= positions)) {
    throw new Error('Invalid GR8 People listing position evidence');
  }
  return positions;
}

function publishedLocation(row: Row, structured: Row): string {
  const places = record(row.places).nodes;
  const listed = Array.isArray(places) ? places.map(place => text(record(place).name)).filter(Boolean) : [];
  const primary = text(record(row.primaryPlace).name);
  const structuredPlaces: unknown[] = Array.isArray(structured.jobLocation) ? structured.jobLocation : [structured.jobLocation];
  const addresses = structuredPlaces.map(place => {
    const address = record(record(place).address);
    return [...new Set([address.addressLocality, address.addressRegion, address.addressCountry].map(text).filter(Boolean))].join(', ');
  }).filter(Boolean);
  const locations = listed.length ? listed : primary ? [primary] : addresses;
  const result = [...new Set(locations)].join('; ');
  if (row.workplaceType !== 'REMOTE') return result;
  return result ? `${result} (Remote)` : 'Remote';
}

export function parseGr8PeopleListing(slug: string, response: unknown, offset: number) {
  const boardUrl = gr8PeopleBoardUrl(slug);
  const envelope = record(response);
  const results = record(record(record(envelope.data).searchJobs).results);
  const { nodes, totalCount } = results;
  const { hasNextPage } = record(results.pageInfo);
  const unavailable = new Set<number>();
  if (Array.isArray(envelope.errors)) {
    for (const entry of envelope.errors) {
      const { path, extensions } = record(entry);
      // The publisher's search index occasionally includes a posting its live
      // resolver can no longer find. An exact null slot may be accounted for
      // without inventing a posting or skipping any position on the next page.
      if (!Array.isArray(path) || path.length < 4 || path[0] !== 'searchJobs' || path[1] !== 'results'
        || path[2] !== 'nodes' || !Number.isSafeInteger(path[3]) || record(extensions).code !== 'NOT_FOUND'
        || !Array.isArray(nodes) || nodes[path[3]] !== null) {
        throw new AtsTemporaryUnavailableError('gr8people', 'public job search returned GraphQL errors');
      }
      unavailable.add(path[3]);
    }
  } else if (envelope.errors != null) {
    throw new AtsTemporaryUnavailableError('gr8people', 'public job search returned invalid GraphQL errors');
  }
  if (!Array.isArray(nodes) || typeof totalCount !== 'number' || !Number.isSafeInteger(totalCount) || totalCount < 0
    || nodes.length !== Math.min(GR8_PEOPLE_PAGE_SIZE, Math.max(0, totalCount - offset))
    || hasNextPage !== (offset + nodes.length < totalCount)) {
    throw new Error('GR8 People job search returned inconsistent pagination');
  }

  const keys = new Set<string>();
  const nonOpenPostings: Array<{ key: string; status: string }> = [];
  const jobs = nodes.flatMap((node, index): Row[] => {
    if (unavailable.has(index)) return [];
    const row = record(node);
    const key = text(row.key);
    const status = text(row.status);
    if (!/^[1-9]\d*$/.test(key) || keys.has(key)) throw new Error('GR8 People job search returned an unverified posting');
    keys.add(key);
    if (nonOpenStatuses.has(status)) {
      unavailable.add(index);
      nonOpenPostings.push({ key, status });
      return [];
    }
    const title = text(row.title);
    const description = text(row.descriptionHTML);
    const structured = record(JSON.parse(text(row.structuredDataJSON) || '{}'));
    const company = publishedEmployerName(record(structured.hiringOrganization).name);
    // The public URL key and the employer's requisition number can differ.
    const structuredIdentifier = text(structured.identifier) || text(record(structured.identifier).value);
    if (!title || !description || !company || status !== 'OPEN' || !['EXTERNAL', 'INT_EXT'].includes(text(row.postType))
      || structured['@type'] !== 'JobPosting' || text(structured.title) !== title
      || !structuredIdentifier || structuredIdentifier !== text(row.number)
      || (slug === teradataHost && company !== 'Teradata')) {
      throw new Error('GR8 People job search returned an unverified posting');
    }
    const postedCompensation = extractStructuredBaseCompensation([{
      currency: text(row.currencyCode),
      frequency: row.payRangeType === 'ANNUAL' ? 'YEAR' : undefined,
      rangeStart: typeof row.payRangeLow === 'number' ? row.payRangeLow : undefined,
      rangeEnd: typeof row.payRangeHigh === 'number' ? row.payRangeHigh : undefined,
    }]);
    return [{
      id: `${slug}::${key}`,
      publicAtsPostingId: key,
      title, company, description,
      url: `${boardUrl}/${key}`,
      location: publishedLocation(row, structured),
      workplaceType: text(row.workplaceType),
      createdAt: text(structured.datePosted) || text(row.postedOn),
      postedCompensation,
    }];
  });
  return {
    jobs,
    metadata: {
      listingHasMore: hasNextPage,
      ...(unavailable.size ? { listingUnavailableSlots: [...unavailable].sort((a, b) => a - b) } : {}),
      ...(nonOpenPostings.length ? { listingNonOpenPostings: nonOpenPostings } : {}),
    },
    total: totalCount,
  };
}
