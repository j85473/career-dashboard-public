import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { atsListingPositionsConsumed, parseGr8PeopleListing } from '../gr8PeopleBoard';
import { atsListingPageSize, buildAtsBoardRequest, parseAtsListingPayload } from '../atsAcquisition';
import { planAtsV2PageCompletion } from '../atsAcquisitionDispatcherV2';
import { knownAtsBoardFromUrl } from '../atsWebDiscoveryLinks';
import { FIRST_COLLECTION_PLATFORMS, isFirstCollectionPlatform } from '../atsFirstCollectionAdmission';
import { generatePostingIdentity } from '../jobIngestion';
import { identifyAts } from '../atsUtils';
import { validateSlug } from '../../scripts/discoverATS';
import { publicAtsTestFixtures } from './publicAtsFixtures';

const platform = 'gr8people';
const slug = 'careers.teradata.com';
const postingUrl = `https://${slug}/jobs/220925/senior-manager-partner-operations`;
type Fixture = { data: { searchJobs: { results: { nodes: Array<Record<string, unknown> | null>; totalCount: number; pageInfo: { hasNextPage: boolean } } } }; errors?: unknown[] };
const fixture = (): Fixture => structuredClone(publicAtsTestFixtures.gr8people) as Fixture;

test('GR8 People public listing and posting URLs identify schedulable boards', () => {
  assert.equal(identifyAts({ url: postingUrl }), 'GR8 People');
  assert.equal(identifyAts({ source: 'ATS-gr8people' }), 'GR8 People');
  assert.deepEqual(knownAtsBoardFromUrl(postingUrl), { platform, slug, matchedUrl: postingUrl });
  assert.equal(knownAtsBoardFromUrl('https://troweprice.gr8people.com/jobs/22303/example')?.slug, 'troweprice.gr8people.com');
  for (const url of [
    'https://teradatainternal.gr8people.com/jobs',
    'https://assets.gr8people.com/jobs',
    'https://careers.teradata.com.example.com/jobs/220925',
    'https://careers.teradata.com/graphql',
  ]) assert.equal(knownAtsBoardFromUrl(url), null);
  assert.equal(isFirstCollectionPlatform(platform), true);
});

test('acquisition and validation share the same bounded GR8 People search', async () => {
  const request = buildAtsBoardRequest({ platform, slug }, 40);
  assert.equal(atsListingPageSize(platform), 40);
  assert.equal(request.url, `https://${slug}/graphql`);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.equal(JSON.parse(request.init.body as string).variables.start, 40);
  assert.throws(() => buildAtsBoardRequest({ platform, slug }, 39), /offset/);
  assert.deepEqual(await validateSlug(platform, slug, undefined, async (url, init) => {
    assert.equal(url, request.url);
    assert.equal(JSON.parse(init?.body as string).variables.start, 0);
    return Response.json(fixture());
  }), { success: true, jobsFound: 1 });
  const page = parseAtsListingPayload(platform, fixture(), null, { platform, slug });
  const [job] = page.jobs;
  assert.equal(job.id, `${slug}::220925`);
  assert.equal(job.company, 'Teradata');
  assert.equal(job.location, 'United States (Remote)');
  assert.equal(job.postedCompensation, '$132,900–$199,300 base');
  assert.equal(generatePostingIdentity({ url: String(job.url) }), generatePostingIdentity({ url: postingUrl }));
  assert.notEqual(generatePostingIdentity({ url: String(job.url) }), generatePostingIdentity({ url: `https://${slug}/jobs/220926` }));
});

test('a confirmed unavailable GR8 People search slot advances pagination without creating a posting', () => {
  const response = fixture();
  const results = response.data.searchJobs.results;
  const row = results.nodes[0]!;
  results.nodes = Array.from({ length: 40 }, (_, index) => index === 5 ? null : { ...row, key: String(200000 + index) });
  results.totalCount = 41;
  results.pageInfo.hasNextPage = true;
  response.errors = [{ path: ['searchJobs', 'results', 'nodes', 5, 'title'], extensions: { code: 'NOT_FOUND' } }];
  const page = parseGr8PeopleListing(slug, response, 0);
  assert.equal(page.jobs.length, 39);
  assert.deepEqual(page.metadata.listingUnavailableSlots, [5]);
  const responseCount = atsListingPositionsConsumed(platform, page.metadata, page.jobs.length);
  assert.equal(responseCount, 40);
  assert.deepEqual(planAtsV2PageCompletion({ platform, requestedOffset: 0, responseCount, providerTotal: page.total, listingHasMore: true }),
    { listingComplete: false, anomaly: null });
  assert.throws(() => parseGr8PeopleListing(slug, { ...response, errors: [] }, 0), /unverified posting/);
  assert.throws(() => parseGr8PeopleListing(slug, { ...response, errors: [{ message: 'HTTP 429' }] }, 0), /temporarily unavailable/);
  assert.throws(() => parseGr8PeopleListing(slug, fixture(), 40), /inconsistent pagination/);
});

test('the admission migration protects all managed boards and seeds only Teradata', () => {
  const sql = readFileSync('prisma/migrations/20261118180000_gr8_people_acquisition/migration.sql', 'utf8');
  const guards = [...sql.matchAll(/NEW\.platform (?:NOT )?IN \(([^)]+)\)/g)];
  assert.equal(guards.length, 2);
  for (const guard of guards) {
    assert.deepEqual([...guard[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort(), [...FIRST_COLLECTION_PLATFORMS].sort());
  }
  assert.match(sql, /'careers\.teradata\.com', 'gr8people', 'https:\/\/careers\.teradata\.com\/jobs'/);
  assert.match(sql, /ON CONFLICT \(slug, platform\) DO NOTHING/);
});
