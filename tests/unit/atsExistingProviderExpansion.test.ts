import test from 'node:test';
import assert from 'node:assert/strict';
import { clearCompanyEmbeddedSiteIds, admittedClearCompanySlug } from '../../src/lib/clearcompanyBoard';
import { tenantAtsBoardSlugFromUrl, tenantAtsConfig, parseTenantAtsListing } from '../../src/lib/tenantAtsBoards';
import { buildPublicAtsBoardRequest, publicAtsNeedsConfig } from '../../src/lib/publicAtsBoards';
import { extractAtsDiscoveryLinks } from '../../src/lib/atsWebDiscoveryLinks';
import { identifyAts } from '../../src/lib/atsUtils';
import { tickFirstCollections } from '../../src/lib/atsFirstCollectionController';
import { parseSymphonyConfig, parseSymphonyListing, symphonyBoardSlugFromUrl, symphonyPostingIdentity, symphonyBoardRequest } from '../../src/lib/symphonyAtsBoard';
import { parseSymphonyPosting } from '../../src/lib/symphonyPosting';
import { PLATFORMS, patternsFor } from '../../src/scripts/discoverATS';
import { localCrawlPatternMatches } from '../../src/lib/localCommonCrawl';
import { auditIndicesMissingCoverage } from '../../scripts/audit_ats_common_crawl';

const site = '4edf5447-97a4-5997-e378-68bb4af139ca';
const jobId = 'f54bd544-01ed-9f3f-c8c8-99150a747e1b';
const widget = `<script src="https://careers-content.clearcompany.com/js/v1/career-site.js?hosted=true" data-site-id="${site}"></script>`;
const description = '<p>Lead customer account planning, partner activation, training and performance reviews. Develop sales opportunities and coordinate cross-functional teams. Qualifications include account management and commercial leadership experience.</p>'.repeat(4);

test('the requested HRMDirect historical backfill earns separate coverage without resetting old receipts', () => {
  const pattern = '*.hrmdirect.com/employment/*';
  assert.ok(patternsFor(PLATFORMS.clearcompany).includes(pattern));
  assert.equal(localCrawlPatternMatches(pattern, 'https://franklincovey.hrmdirect.com/employment/job-openings.php?search=true'), true);
  for (const url of ['https://franklincovey.hrmdirect.com/assets/widget.js', 'https://hrmdirect.com/employment/', 'https://franklincovey.hrmdirect.com.evil.example/employment/']) {
    assert.equal(localCrawlPatternMatches(pattern, url), false);
  }
  const indices = ['CC-MAIN-2026-39-index', 'CC-MAIN-2026-43-index'];
  const old = indices.map(indexId => ({ platform: 'clearcompany', pattern: '*.hrmdirect.com/*', indexId }));
  const original = JSON.stringify(old), work = [{ platformKey: 'clearcompany' as const, pattern }];
  assert.deepEqual(auditIndicesMissingCoverage(indices, work, old), indices);
  assert.deepEqual(auditIndicesMissingCoverage(indices, work, [...old, ...indices.map(indexId => ({ platform: 'clearcompany', pattern, indexId }))]), []);
  assert.equal(JSON.stringify(old), original);
});

test('ClearCompany hosted and migrated HRMDirect boards resolve to the same existing UUID identity', () => {
  assert.equal(publicAtsNeedsConfig('clearcompany', site), false);
  assert.equal(publicAtsNeedsConfig('clearcompany', 'hosted::franklincovey'), true);
  for (const [url, slug] of [
    ['https://apply.clearcompany.com/franklincovey?jobId=' + jobId, 'hosted::franklincovey'],
    ['https://franklincovey.hrmdirect.com/employment/job-openings.php?search=true', 'hrmdirect::franklincovey'],
    ['https://franklincovey.hrmdirect.com/employment/', 'hrmdirect::franklincovey'],
    ['https://franklincovey.clearcompany.com/careers/jobs/' + jobId + '/apply', 'hosted::franklincovey'],
  ]) {
    assert.equal(identifyAts({ url }), 'ClearCompany');
    assert.equal(tenantAtsBoardSlugFromUrl(url, 'clearcompany'), slug);
    const config = tenantAtsConfig('clearcompany', slug, widget, 'https://apply.clearcompany.com/franklincovey');
    assert.equal(admittedClearCompanySlug(slug, config.canonicalSlug), site);
    assert.equal(new URL(buildPublicAtsBoardRequest('clearcompany', slug, 20, config).url).pathname, '/v1/' + site);
    const payload = { currentPageIndex: 0, totalCount: 1, results: [{ id: jobId, positionTitle: 'Client Partner', brandName: 'FranklinCovey',
      description, applyLink: 'https://franklincovey.clearcompany.com/careers/jobs/' + jobId + '/apply', location: 'Remote (US)', locations: [{ country: 'US', isRemote: true }] }] };
    const original = JSON.stringify(payload);
    const job = parseTenantAtsListing('clearcompany', slug, payload, null, config).jobs[0];
    assert.equal(job.id, site + '::' + jobId);
    assert.equal(job.location, 'Remote (US)');
    assert.equal(job.company, 'FranklinCovey');
    assert.equal(JSON.stringify(payload), original);
    assert.throws(() => parseTenantAtsListing('clearcompany', slug, { ...payload, results: [{ ...payload.results[0], applyLink: payload.results[0].applyLink.replace(jobId, 'other') }] }, null, config));
  }
  assert.equal(admittedClearCompanySlug(site), site);
});

test('ClearCompany widget discovery works on employer pages and rejects unrelated scripts and conflicting identities', () => {
  const result = extractAtsDiscoveryLinks(widget, 'https://employer.example/careers');
  assert.deepEqual(result.boards.map(b => [b.platform, b.slug]), [['clearcompany', site]]);
  for (const html of [widget.replace('careers-content.clearcompany.com', 'evil.example'), widget.replace('/js/v1/career-site.js', '/unrelated.js'), widget.replace('data-site-id', 'data-other'), widget.replace(site, 'not-a-site')]) {
    assert.deepEqual(clearCompanyEmbeddedSiteIds(html, 'https://employer.example/'), []);
  }
  assert.throws(() => tenantAtsConfig('clearcompany', 'hosted::franklincovey', widget, 'https://apply.clearcompany.com/other'));
  assert.throws(() => tenantAtsConfig('clearcompany', 'hosted::franklincovey', widget + widget.replace(site, '2689161f-e9d9-0c51-6eb1-9bd9001f4df7')));
  assert.deepEqual(clearCompanyEmbeddedSiteIds(widget + widget.replace('hosted=true', 'siteId=2689161f-e9d9-0c51-6eb1-9bd9001f4df7'), 'https://employer.example/'), []);
  assert.throws(() => admittedClearCompanySlug('hosted::franklincovey', '../other'));
  assert.throws(() => buildPublicAtsBoardRequest('clearcompany', 'hosted::franklincovey'));
  for (const url of ['https://apply.clearcompany.com.evil.example/franklincovey', 'https://user@apply.clearcompany.com/franklincovey', 'https://apply.clearcompany.com:444/franklincovey']) {
    assert.equal(tenantAtsBoardSlugFromUrl(url, 'clearcompany'), null);
  }
});

test('resolved ClearCompany aliases honor the retired UUID without creating a second board or changing existing work', async () => {
  const updates: Record<string, unknown>[] = [], now = new Date();
  const policy = { id: 'new-providers', mode: 'capacity', maxUnfinished: 32, maxCatalogueJobs: 250, maxResponseBytes: 5242880, pilotBoards: [], dailyBoardLimit: 5, healthySince: now, healthObservedAt: now };
  const tx = {
    $queryRaw: async (query: { text?: string }) => query.text?.includes('WITH platform_turns')
      ? [{ platform: 'clearcompany', slug: 'hosted::franklincovey' }]
      : [{ unfinished: BigInt(0), items: BigInt(0), bytes: BigInt(0), persistence: BigInt(0), totalPersistence: BigInt(0), gate: 'open' }],
    $executeRaw: async () => 0,
    atsFirstCollectionPolicy: { findUniqueOrThrow: async () => policy, update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(policy, data) },
    atsCompany: { count: async () => 0, findMany: async ({ where }: { where: { OR: { slug: { equals: string } }[] } }) => {
      assert.equal(where.OR[0].slug.equals, site);
      return [{ slug: site, platform: 'clearcompany', status: 'excluded', excludedReason: 'Retired by Joe' }];
    }, create: async () => { throw Error('Must not create another board'); }, updateMany: async () => { throw Error('Must not reopen retired work'); } },
    atsFirstCollectionCandidate: { findFirst: async () => ({ platform: 'clearcompany', slug: 'hosted::franklincovey' }), update: async (input: Record<string, unknown>) => updates.push(input) },
  };
  const client = { $transaction: async (work: (value: typeof tx) => unknown) => work(tx) };
  const result = await tickFirstCollections(async () => ({ success: true, jobsFound: 17, canonicalSlug: site }), now, client as never);
  assert.equal(result.outcome, 'retired');
  assert.deepEqual(updates.at(-1)?.where, { slug_platform: { platform: 'clearcompany', slug: 'hosted::franklincovey' } });
  assert.equal((updates.at(-1)?.data as Record<string, unknown>).state, 'retired');
});

const symphony = {
  hgv: { host: 'careers.hgv.com', organization: '66818394-0397-4ae2-9aff-2893667aba0b', scout: 2012, company: 'Hilton Grand Vacations', branding: 'Hilton Grand Vacations', path: '/job-en', home: '/', portal: 'orc_mule_en' },
  victoriassecret: { host: 'careers.victoriassecret.com', organization: '382ab4db-03e8-40cc-b413-51539aca9954', scout: 2391, company: 'Victorias Secret & Co', branding: "Victoria's Secret", path: '/en/job', home: '/en/', portal: 'SuccesFactors' },
};
for (const [slug, b] of Object.entries(symphony)) test(`${slug} verifies public configuration, employer-scoped identities, actual location and full details`, () => {
  const options = { org: 'companies/' + b.organization, smartPost_org: String(b.scout), api: 'https://jobsapi-google.m-cloud.io/api/', job_detail_path: b.path };
  const html = `<title>${b.branding} Careers</title><script>var cws_opts = ${JSON.stringify(options)};</script>`;
  assert.equal(parseSymphonyConfig(slug, html, 'https://' + b.host + b.home).company, b.company);
  assert.throws(() => parseSymphonyConfig(slug, html.replace(b.organization, '00000000-0397-4ae2-9aff-2893667aba0b')));
  const url = 'https://' + b.host + b.path + '/24128508/sales-manager/';
  assert.equal(symphonyBoardSlugFromUrl(url), slug);
  assert.deepEqual(symphonyPostingIdentity(url), { slug, id: '24128508' });
  assert.equal(new URL(symphonyBoardRequest(slug, 20).url).searchParams.get('offset'), '20');
  const job = { id: 24128508, url, company_name: b.company, scout_orgid: b.scout, ats_portalid: b.portal, ref: '27215', title: 'Sales Manager', description, level: 'Sales and Marketing', primary_city: 'Gainesville', primary_state: 'VA', primary_country: 'US' };
  const payload = { totalHits: 1, nextPageToken: null, searchResults: [{ job }] };
  assert.equal(parseSymphonyListing(slug, payload).jobs[0].location, 'Gainesville, VA, US');
  assert.equal(parseSymphonyPosting(job, url)?.company, b.company);
  for (const changed of [{ scout_orgid: 1 }, { company_name: 'Another company' }, { ats_portalid: 'internal' }, { url: url.replace('24128508', '1') }]) {
    assert.throws(() => parseSymphonyListing(slug, { ...payload, searchResults: [{ job: { ...job, ...changed } }] }));
  }
  assert.equal(symphonyBoardSlugFromUrl(url.replace(b.host, b.host + '.evil.example')), null);
});
