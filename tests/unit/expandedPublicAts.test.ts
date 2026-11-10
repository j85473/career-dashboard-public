import assert from 'node:assert/strict';
import test from 'node:test';
import { completeExpandedListing, expandedBoardSlug, expandedBoardUrl, expandedConfig, expandedRequest, parseCornerstonePosting,
  parseExpandedListing, parsePolymerDetail, polymerLocation } from '../../src/lib/expandedPublicAts';
import { publicAtsTestFixtures as fixtures } from '../../src/lib/__tests__/publicAtsFixtures';
import { enrichAtsListingJob, readAtsJobEnrichmentMarker } from '../../src/lib/atsJobEnrichment';
import { requirePublicAtsEmployer } from '../../src/lib/jobIngestion';

const token = (corp = 'example') => `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ corp, exp: 4102444800 })).replace(/=+$/, "")}.signature`;
const slug = 'example.csod.com::1::default';
const context = { corp: 'example', user: -1, cultureID: 1, cultureName: 'en-US', token: token(), endpoints: { cloud: 'https://us.api.csod.com/' } };
const page = (overrides = {}, reqid = '123') => `<script>var csodPlayerRouteInfo=${JSON.stringify({ cid: '1', routeInfo: { reqid } })};csod.context=${JSON.stringify({ ...context, ...overrides })};</script>`;
const posting = () => page() + `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', Title: 'Channel Manager',
  Description: '<p>Full role description.</p>', HiringOrganization: { Name: 'Example Inc' },
  jobLocation: [{ Address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: { Name: 'US' } } }] })}</script>`;
const polymerJob = (id = 123) => ({ id, title: 'Channel Manager', organization_name: 'Example Inc',
  job_post_url: `https://jobs.polymer.co/example/${id}`, display_location: 'Austin, TX', description: '<p>Full role description.</p>', archived_at: null });
const polymerPage = (items = [polymerJob()], overrides = {}) => ({ items, meta: { count: 1, total: 1, page: 1,
  is_first: true, is_last: true, next_page: null, organization_name: 'Example Inc', ...overrides } });

test('public board identities keep Cornerstone site and locale and reject conflicting tenants', () => {
  assert.equal(expandedBoardSlug('cornerstone', 'https://example.csod.com/ats/careersite/jobdetails.aspx?site=1&id=123'), slug);
  assert.equal(expandedBoardSlug('cornerstone', 'https://example.csod.com/ux/ats/careersite/1/home?lang=fr-CA'), 'example.csod.com::1::fr-CA');
  assert.equal(expandedBoardSlug('cornerstone', 'https://example.csod.com/ux/ats/careersite/1/home?c=other'), null);
  assert.equal(expandedBoardSlug('polymer', 'https://jobs.polymer.co.evil.test/example/123'), null);
  assert.equal(expandedBoardSlug('hireology', 'https://user:password@careers.hireology.com/example/123/description'), null);
  assert.equal(expandedBoardUrl('hireology', 'site::example.hireology.careers'), 'https://example.hireology.careers/');
  assert.throws(() => expandedBoardUrl('cornerstone', '127.0.0.1::1::default'));
});

test('anonymous Cornerstone tokens are bound to the published tenant, site, locale and regional API', () => {
  const config = expandedConfig('cornerstone', slug, page());
  const request = expandedRequest('cornerstone', slug, 20, config);
  assert.equal(request.url, 'https://us.api.csod.com/rec-job-search/external/jobs');
  assert.equal(JSON.parse(String(request.init.body)).pageNumber, 2);
  assert.equal(JSON.parse(String(request.init.body)).careerSiteId, 1);
  for (const bad of [{ corp: 'other' }, { token: token('other') }, { user: 1 },
    { endpoints: { cloud: 'https://us.api.csod.com.evil.test/' } }, { endpoints: { cloud: 'https://us.api.csod.com/?token=secret' } }]) assert.throws(() => expandedConfig('cornerstone', slug, page(bad)));
  assert.throws(() => expandedConfig('cornerstone', 'example.csod.com::1::fr-CA', page()));
  assert.throws(() => expandedConfig('cornerstone', slug, page(), 'https://other.csod.com/ux/ats/careersite/1/home'));
  assert.throws(() => expandedRequest('cornerstone', slug, 1, config));
});

test('Hireology aliases resolve only from their public configuration and emit no token-bearing fields', () => {
  const html = `<script>var startingData=${JSON.stringify({ apiToken: token(), apiUrl: 'https://api.hireology.com/v2', appUrl: 'https://careers.hireology.com', careersPath: 'example' })};</script>`;
  const config = expandedConfig('hireology', 'site::example.hireology.careers', html);
  assert.equal(config.canonicalSlug, 'example');
  const request = expandedRequest('hireology', 'site::example.hireology.careers', 20, config);
  assert.equal(request.url, 'https://api.hireology.com/v2/public/careers/example?page=2&page_size=20');
  const raw = structuredClone(fixtures.hireology) as { data: Record<string, unknown>[] };
  raw.data[0].third_party_service_data = { token: 'MUST_NOT_PERSIST' };
  const parsed = parseExpandedListing('hireology', 'example', raw, config);
  assert.equal(parsed.jobs[0].company, 'Example Inc');
  assert.equal(JSON.stringify(parsed).includes(token()), false);
  assert.equal(JSON.stringify(parsed).includes('MUST_NOT_PERSIST'), false);
  assert.throws(() => expandedConfig('hireology', 'other', html));
  assert.throws(() => parseExpandedListing('hireology', 'example', { ...raw, page: 2 }));
  assert.throws(() => parseExpandedListing('hireology', 'example', { ...raw, data: [{ ...raw.data[0], career_site_url: 'https://careers.hireology.com/other/123/description' }] }));
});

test('Cornerstone never promotes a sampled employer to a board or later page', async () => {
  const feed = parseExpandedListing('cornerstone', slug, fixtures.cornerstone, { company: 'Unrelated sampled employer' });
  assert.equal(feed.jobs[0].company, '');
  const completed = await completeExpandedListing('cornerstone', slug, feed, async () => { throw Error('Listing must not sample an employer'); });
  assert.equal(completed.jobs[0].company, '');
  assert.equal(completed.metadata.name, '');
  assert.equal(feed.jobs[0].company, '', 'the downloaded input remains immutable');
  assert.equal(parseCornerstonePosting(posting(), String(feed.jobs[0].url)).location, 'Austin, TX, US');
  assert.throws(() => parseCornerstonePosting(posting().replace('"reqid":"123"', '"reqid":"999"'), String(feed.jobs[0].url)));
  assert.throws(() => parseCornerstonePosting(posting(), String(feed.jobs[0].url), 'Different Title'));
  assert.throws(() => requirePublicAtsEmployer('cornerstone', 'Unknown Company'), /verified employer/);
});

test('Cornerstone recovers an explicit location header when structured evidence gives only a country', () => {
  const url = 'https://example.csod.com/ux/ats/careersite/1/home/requisition/123';
  const detail = (description: string, address: Record<string, unknown> = { addressCountry: { Name: 'US' } }) =>
    page() + `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', Title: 'Channel Manager',
      Description: description, HiringOrganization: { Name: 'Example Inc' }, jobLocation: [{ Address: address }] })}</script>`;
  const full = '<p>We operate in India, the Netherlands and Hungary.</p><p><span><strong>Location</strong>: Atlanta<br>'
    + '<strong>Reports to (Position)</strong>: National Sales Head (Americas)<br><p>Support distributors across North America.</p>';
  assert.equal(parseCornerstonePosting(detail(full), url).location, 'Atlanta, US');
  assert.equal(parseCornerstonePosting(detail(full), url).description, full);
  assert.equal(parseCornerstonePosting(detail(full, { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' }), url).location, 'Austin, TX, US');
  assert.equal(parseCornerstonePosting(detail('<p>Location: Atlanta, US</p>'), url).location, 'Atlanta, US');
  assert.equal(parseCornerstonePosting(detail('<p>Location: Atlanta, United States</p>'), url).location, 'Atlanta, United States');
  assert.equal(parseCornerstonePosting(detail('<p>Location: Atlanta</p>', {}), url).location, 'Atlanta');
  for (const text of ['<p>Visit our Atlanta office and US distributors.</p>',
    '<p>Location: Atlanta</p><p>Location: Austin</p>', '<p>Location: Not specified</p>']) {
    assert.equal(parseCornerstonePosting(detail(text), url).location, 'US');
  }
});

test('Cornerstone binds each retained posting to its own employer and retries unverifiable details', async () => {
  const raw = parseExpandedListing('cornerstone', slug, fixtures.cornerstone).jobs[0];
  const deps = {
    safeExternalFetch: async () => new Response(posting()),
    fetchPlatformResponse: async (_p: string, _s: unknown, request: () => Promise<Response>, options?: { onResponse?: (response: Response) => Promise<void> }) => {
      const response = await request(); await options?.onResponse?.(response); return response;
    },
    reserveProviderBudgetForSource: async () => ({ allowed: true }), recordProviderSuccess: async () => {}, recordProviderFailure: async () => null,
    passesPreFilter: () => ({ passes: true, reason: '' }),
    createDeferredError: () => Object.assign(new Error('Retain for retry'), { name: 'AtsPlatformDeferredError' }),
  };
  const first = await enrichAtsListingJob({ platform: 'cornerstone', slug, job: raw, requestTimeoutMs: 1000 }, deps);
  assert.equal(readAtsJobEnrichmentMarker(first)?.company, 'Example Inc');
  assert.equal(readAtsJobEnrichmentMarker(first)?.description, '<p>Full role description.</p>');
  const header = '<p><strong>Location</strong>: Atlanta<br>Reports to: National Sales Head</p><p>Full role description.</p>';
  const fullDetail = posting().replace(JSON.stringify('<p>Full role description.</p>'), JSON.stringify(header))
    .replace('"addressLocality":"Austin","addressRegion":"TX",', '');
  const improved = await enrichAtsListingJob({ platform: 'cornerstone', slug, job: { ...raw, location: 'US' }, requestTimeoutMs: 1000 }, {
    ...deps, safeExternalFetch: async () => new Response(fullDetail),
  });
  assert.equal(readAtsJobEnrichmentMarker(improved)?.location, 'Atlanta, US');
  assert.equal(readAtsJobEnrichmentMarker(improved)?.description, header, 'keep the header omitted from the listing feed');
  const second = { ...raw, id: `${slug}::124`, publicAtsPostingId: '124', url: String(raw.url).replace('/123', '/124'), company: 'Example Inc' };
  const before = structuredClone(second);
  const result = await enrichAtsListingJob({ platform: 'cornerstone', slug, job: second, requestTimeoutMs: 1000 }, {
    ...deps, safeExternalFetch: async () => new Response(posting().replace('"reqid":"123"', '"reqid":"124"').replace('Example Inc', 'Separate Employer LLC')),
  });
  assert.equal(readAtsJobEnrichmentMarker(result)?.company, 'Separate Employer LLC');
  assert.deepEqual(second, before);
  await assert.rejects(enrichAtsListingJob({ platform: 'cornerstone', slug, job: second, requestTimeoutMs: 1000 }, deps), { name: 'AtsPlatformDeferredError' });
  const rejected = await enrichAtsListingJob({ platform: 'cornerstone', slug, job: { ...raw, title: 'Registered Nurse' }, requestTimeoutMs: 1000 }, {
    ...deps, passesPreFilter: () => ({ passes: false, reason: 'Title excluded' }),
    safeExternalFetch: async () => { throw Error('Rejected title must not spend a detail request'); },
  });
  assert.equal(readAtsJobEnrichmentMarker(rejected)?.attempted, false);
});

test('Polymer follows provider page numbers without guessing a page size or losing repeated-page failures', async () => {
  const first = parseExpandedListing('polymer', 'example', polymerPage([polymerJob()], { count: 2, total: 2, is_last: false, next_page: 2 }));
  const next = polymerPage([polymerJob(124)], { count: 2, total: 2, page: 2, is_first: false });
  const requests: string[] = [];
  const feed = await completeExpandedListing('polymer', 'example', first, async url => { requests.push(url); return { url, body: JSON.stringify(next) }; });
  assert.equal(feed.jobs.length, 2);
  assert.deepEqual(requests, ['https://api.polymer.co/v1/hire/organizations/example/jobs?page=2']);
  await assert.rejects(completeExpandedListing('polymer', 'example', first, async url => ({ url, body: JSON.stringify({ ...next, items: [polymerJob()] }) })), /repeated page/);
  await assert.rejects(completeExpandedListing('polymer', 'example', first, async url => ({ url, body: JSON.stringify({ ...next, meta: { ...next.meta, count: 3 } }) })), /changed/);
  assert.throws(() => parseExpandedListing('polymer', 'example', polymerPage([], { count: 5 })), /pagination/);
  const empty = parseExpandedListing('polymer', 'example', polymerPage([], { count: 0, total: 0, is_last: false }));
  assert.equal((await completeExpandedListing('polymer', 'example', empty, async () => { throw Error('No request expected'); })).jobs.length, 0);
});

test('Polymer preserves published remote country restrictions and validates exact detail identity', () => {
  assert.equal(polymerLocation({ ...polymerJob(), remoteness_pretty: 'Remote', remote_restriction_country_residency_is_required: true, remote_restriction_country_list: ['DE'] }), 'Remote (Germany)');
  assert.equal(polymerLocation({ ...polymerJob(), remoteness_pretty: 'Remote', remote_restriction_country_residency_is_required: true, remote_restriction_country_list: ['CA'] }), 'Remote (Canada)');
  assert.equal(polymerLocation({ ...polymerJob(), remoteness_pretty: 'Remote', remote_restriction_country_residency_is_required: false }), 'Remote (Worldwide)');
  const detail = parsePolymerDetail(polymerJob(), 'https://jobs.polymer.co/example/123?utm_source=test');
  assert.equal(detail.company, 'Example Inc');
  assert.throws(() => parsePolymerDetail(polymerJob(124), 'https://jobs.polymer.co/example/123'));
  assert.throws(() => parsePolymerDetail({ ...polymerJob(), job_post_url: 'https://careers.hireology.com/example/123/description' }, 'https://jobs.polymer.co/example/123'));
  assert.throws(() => parsePolymerDetail({ ...polymerJob(), archived_at: '2026-11-10' }, 'https://jobs.polymer.co/example/123'));
});

test('Polymer enrichment obtains a description through the existing request and marker boundary', async () => {
  const raw = parseExpandedListing('polymer', 'example', polymerPage()).jobs[0], original = structuredClone(raw);
  const requests: string[] = [];
  const enriched = await enrichAtsListingJob({ platform: 'polymer', slug: 'example', job: raw, requestTimeoutMs: 1000 }, {
    fetch: async target => { requests.push(String(target)); return Response.json(polymerJob()); },
    fetchPlatformResponse: async (_platform, _signal, request, options) => { const response = await request(); await options?.onResponse?.(response); return response; },
    reserveProviderBudgetForSource: async () => ({ allowed: true }), recordProviderSuccess: async () => {}, recordProviderFailure: async () => null,
    passesPreFilter: () => ({ passes: true, reason: '' }),
  });
  assert.equal(readAtsJobEnrichmentMarker(enriched)?.description, '<p>Full role description.</p>');
  assert.deepEqual(raw, original);
  assert.deepEqual(requests, ['https://api.polymer.co/v1/hire/organizations/example/jobs/123']);
});
