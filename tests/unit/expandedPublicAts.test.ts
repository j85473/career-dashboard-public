import assert from 'node:assert/strict';
import test from 'node:test';
import { completeExpandedListing, expandedBoardSlug, expandedBoardUrl, expandedConfig, expandedRequest, parseCornerstonePosting,
  parseExpandedListing, parsePolymerDetail, polymerLocation } from '../../src/lib/expandedPublicAts';
import { publicAtsTestFixtures as fixtures } from '../../src/lib/__tests__/publicAtsFixtures';
import { enrichAtsListingJob, readAtsJobEnrichmentMarker } from '../../src/lib/atsJobEnrichment';

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

test('Cornerstone verifies the exact posting before assigning an employer to its listing', async () => {
  const feed = parseExpandedListing('cornerstone', slug, fixtures.cornerstone);
  assert.equal(feed.jobs[0].company, '');
  const completed = await completeExpandedListing('cornerstone', slug, feed, async url => ({ url, body: posting() }));
  assert.equal(completed.jobs[0].company, 'Example Inc');
  assert.equal(feed.jobs[0].company, '', 'the downloaded input remains immutable');
  assert.equal(parseCornerstonePosting(posting(), String(feed.jobs[0].url)).location, 'Austin, TX, US');
  assert.throws(() => parseCornerstonePosting(posting().replace('"reqid":"123"', '"reqid":"999"'), String(feed.jobs[0].url)));
  await assert.rejects(completeExpandedListing('cornerstone', slug, feed, async () => ({ url: 'https://other.csod.com/ux/ats/careersite/1/home/requisition/123', body: posting() })));
  assert.throws(() => parseCornerstonePosting(posting(), String(feed.jobs[0].url), 'Different Title'));
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
