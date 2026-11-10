import assert from 'node:assert/strict';
import test from 'node:test';
import { ADDITIONAL_PUBLIC_ATS, additionalBoardSlug, additionalBoardUrl, additionalRequest, parseAdditionalListing, parseAdditionalDetail } from '../../src/lib/additionalPublicAts';
import { publicAtsBoardSlugFromUrl, buildPublicAtsBoardRequest, parsePublicAtsListing } from '../../src/lib/publicAtsBoards';
import { parseAtsListingPayload, responseMatchesPlatform } from '../../src/lib/atsAcquisition';
import { identifyAts, atsAuthFailureIsPlatformWide, atsResponseSchemaFailureIsPlatformWide } from '../../src/lib/atsUtils';
import { isFirstCollectionPlatform } from '../../src/lib/atsFirstCollectionAdmission';
import { enrichAtsListingJob, readAtsJobEnrichmentMarker } from '../../src/lib/atsJobEnrichment';
import { fetchAdditionalAtsPosting } from '../../src/lib/additionalAtsPosting';

const atom = (entries = `<entry><id>job_123</id><title>Channel Manager</title><author><name>Example Inc</name></author><link rel="alternate" type="text/html" href="https://example.homerun.co/channel-manager"/><description><![CDATA[<p>Full responsibilities and requirements.</p>]]></description><location><name>Berlin, Germany</name></location></entry>`) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>https://example.homerun.co/</id>${entries}</feed>`;
const dvinciJob = () => ({ id: 123, position: 'Channel Manager', language: 'de', jobPublicationURL: 'https://example.dvinci.de/de/jobs/123/channel-manager',
  renderedContent: { introduction: { body: '<p>About the company.</p>' }, tasks: { headline: 'Responsibilities', body: '<p>Develop channel partners.</p>' }, profile: { headline: 'Requirements', body: '<p>Experience in sales.</p>' } },
  jobOpening: { company: { name: 'Example Inc' }, locations: [{ name: 'Berlin', country: { name: 'Deutschland', isoA2: 'DE' } }], salaryRange: 'EUR 60000 / Jahr' } });
const sgJob = () => ({ '@type': 'JobPosting', identifier: { value: 123 }, url: 'https://example.career.softgarden.de/jobs/123/channel-manager/', title: 'Channel Manager', description: '<p>Full responsibilities.</p>', hiringOrganization: { name: 'Example Inc' }, jobLocation: { address: { addressLocality: 'Berlin', addressCountry: 'DE' } } });
const sgFeed = () => ({ '@type': 'DataFeed', meta: { source: 'https://example.career.softgarden.de/' }, numberOfItems: 1, dataFeedElement: [{ item: sgJob() }] });
const classic = (ids = [123], links = [123]) => `<html><script>var complete_job_id_list = jobs_selected = ${JSON.stringify(ids)};</script>${links.map(i => `<div id="job_id_${i}"><a href="../job/${i}/channel-manager">Channel Manager</a><span class="location-view-item">Berlin</span></div>`).join('')}</html>`;
const classicDetail = () => `<html><link rel="canonical" href="https://example.softgarden.io/job/123"><script type="application/ld+json">${JSON.stringify({ ...sgJob(), url: undefined, identifier: { value: 'https://example.softgarden.io/#organization' } })}</script></html>`;
const flatchrJob = () => ({ published: true, status: 'published', vacancy: { status: 1, id: 'AbC123', slug: 'abc123-channel-manager', title: 'Channel Manager', description: '<p>Company introduction.</p>', mission: '<p>Develop partners.</p>', profile: '<p>Experience in sales.</p>', company: { id: 'co123', slug: 'example', name: 'Example Inc' }, address: { locality: 'Paris', country: 'France' }, remote: 'fulltime' } });
const flatchrData = () => ({ page: '/company/[companySlug]', query: { companySlug: 'example' }, props: { config: { published: true, company: { id: 'co123', slug: 'example', IS_INTRANET_WEBSITE: false } }, data: { items: [flatchrJob()] } } });
const flatchrHtml = (d: unknown = flatchrData()) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(d)}</script></html>`;

test('all four providers enter controlled acquisition with board-scoped failures', () => {
  for (const platform of ADDITIONAL_PUBLIC_ATS) {
    assert.equal(isFirstCollectionPlatform(platform), true);
    assert.equal(atsAuthFailureIsPlatformWide(platform), false);
    assert.equal(atsResponseSchemaFailureIsPlatformWide(platform), false);
  }
  assert.equal(additionalBoardSlug('flatchr', 'https://careers.flatchr.io/fr/company/example.json'), 'example');
  assert.equal(additionalBoardSlug('flatchr', 'https://careers.flatchr.io/fr/vacancy/abc123-job'), null);
  assert.equal(additionalBoardSlug('dvinci', 'https://example.dvinci.de/portal/external/jobPublication/list.json'), 'example.dvinci.de::external');
  assert.equal(additionalBoardUrl('dvinci', 'example.dvinci.de::external'), 'https://example.dvinci.de/portal/external/');
  for (const p of ADDITIONAL_PUBLIC_ATS) for (const u of ['https://evil.example/', 'https://help.homerun.co/', 'file:///etc/passwd', 'https://user:pass@example.dvinci.de/', 'https://example.softgarden.io.evil.test/']) assert.equal(additionalBoardSlug(p, u), null);
  assert.throws(() => additionalRequest('homerun', 'example', 20));
  assert.equal(publicAtsBoardSlugFromUrl('https://example.homerun.co/channel-manager', 'homerun'), 'example');
  assert.equal(buildPublicAtsBoardRequest('dvinci', 'example.dvinci.de').url, 'https://example.dvinci.de/jobPublication/list.json');
  assert.equal(responseMatchesPlatform('homerun', 'application/atom+xml'), true);
  assert.equal(responseMatchesPlatform('flatchr', 'application/json'), false);
  assert.equal(identifyAts({ url: 'https://careers.flatchr.io/fr/vacancy/abc123-job/' }), 'Flatchr');
  assert.equal(identifyAts({ source: 'ATS-dvinci' }), 'd.vinci');
});

test('Homerun validates complete XML, published namespace and duplicate posting IDs', () => {
  const f = parsePublicAtsListing('homerun', 'example', {}, atom());
  assert.equal(f.jobs[0].company, 'Example Inc'); assert.match(String(f.jobs[0].description), /requirements/);
  assert.equal(parseAdditionalListing('homerun', 'example', {}, atom('')).total, 0);
  for (const xml of [atom().slice(0,-7), atom().replace('</title>', '</bad>'), atom().replace('https://example.homerun.co/channel-manager','https://other.homerun.co/channel-manager'), atom().replace('<feed ', '<!DOCTYPE feed><feed ')]) assert.throws(() => parseAdditionalListing('homerun', 'example', {}, xml));
  const xml = atom(), entry = xml.match(/<entry>[\s\S]*<\/entry>/)![0];
  assert.throws(() => parseAdditionalListing('homerun', 'example', {}, atom(entry + entry)), /repeated/);
});

test('d.vinci preserves complete content, published companies and portal scope', () => {
  const input = [dvinciJob()], before = structuredClone(input);
  const f = parseAtsListingPayload('dvinci', input, null, { platform: 'dvinci', slug: 'example.dvinci.de' });
  assert.equal(f.jobs[0].company, 'Example Inc'); assert.match(String(f.jobs[0].description), /Requirements/); assert.deepEqual(input, before);
  assert.equal(parseAdditionalListing('dvinci', 'example.dvinci.de', [], null).total, 0);
  assert.equal(parseAdditionalListing('dvinci', 'example.dvinci.de::external', input, null).total, 1);
  assert.throws(() => parseAdditionalListing('dvinci', 'example.dvinci.de::external', [{ ...dvinciJob(), jobPublicationURL: 'https://example.dvinci.de/de/p/internal/jobs/123/channel-manager' }], null));
  assert.throws(() => parseAdditionalListing('dvinci', 'example.dvinci.de', {}, null));
  assert.throws(() => parseAdditionalListing('dvinci', 'example.dvinci.de', [{ ...dvinciJob(), jobPublicationURL: 'https://other.dvinci.de/de/jobs/123' }], null));
  assert.throws(() => parseAdditionalListing('dvinci', 'example.dvinci.de', [{ ...dvinciJob(), jobPublicationURL: 'https://user:pass@example.dvinci.de/de/jobs/123' }], null));
  assert.throws(() => parseAdditionalListing('dvinci', 'example.dvinci.de', [{ ...dvinciJob(), jobPublicationURL: 'https://example.dvinci.de/de/jobs/456' }], null));
  assert.throws(() => parseAdditionalListing('dvinci', 'example.dvinci.de', [dvinciJob(), dvinciJob()], null), /repeated/);
});

test('modern Softgarden rejects partial feeds and preserves country-limited remote evidence', () => {
  const data = sgFeed(); data.dataFeedElement[0].item = { ...sgJob(), jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { name: 'DE' } } as ReturnType<typeof sgJob>;
  const f = parseAdditionalListing('softgarden', 'example.career.softgarden.de', {}, JSON.stringify(data));
  assert.match(String(f.jobs[0].location), /Remote \(Germany\)/);
  assert.match(String(f.jobs[0].location), /Berlin, Germany/);
  assert.throws(() => parseAdditionalListing('softgarden', 'example.career.softgarden.de', {}, JSON.stringify({ ...data, numberOfItems: 2 })), /incomplete/);
  assert.throws(() => parseAdditionalListing('softgarden', 'example.career.softgarden.de', {}, JSON.stringify({ ...data, meta: { source: 'https://other.career.softgarden.de/' } })));
});

test('classic Softgarden requires every declared ID and exact source detail identity', () => {
  assert.equal(parseAdditionalListing('softgarden', 'example.softgarden.io', {}, classic()).total, 1);
  assert.equal(parseAdditionalListing('softgarden', 'example.softgarden.io', {}, classic([], [])).total, 0);
  for (const body of [classic([123,456]), classic([123,123]), classic().slice(0,-7), '<html>Error</html>']) assert.throws(() => parseAdditionalListing('softgarden', 'example.softgarden.io', {}, body));
  const j = parseAdditionalDetail('softgarden','example.softgarden.io',classicDetail(),'https://example.softgarden.io/job/123/channel-manager', 'Channel Manager');
  assert.equal(j.company, 'Example Inc');
  assert.throws(() => parseAdditionalDetail('softgarden','example.softgarden.io',classicDetail().replace('/job/123','/job/456'),'https://example.softgarden.io/job/123/channel-manager', 'Channel Manager'));
  assert.throws(() => parseAdditionalDetail('softgarden','example.softgarden.io',classicDetail(),'https://example.softgarden.io/job/123/channel-manager', 'Different title'));
});

test('Flatchr persists only published job fields and checks employer, intranet and continuation', () => {
  const d = flatchrData(); (d.props as Record<string, unknown>).secret = 'MUST_NOT_PERSIST';
  const f = parseAdditionalListing('flatchr', 'example', {}, flatchrHtml(d));
  assert.equal(f.total, 1); assert.equal(f.jobs[0].company, 'Example Inc'); assert.match(String(f.jobs[0].description), /Develop partners/);
  assert.equal(JSON.stringify(f).includes('MUST_NOT_PERSIST'), false);
  for (const mutate of [(x: ReturnType<typeof flatchrData>) => { x.props.config.company.IS_INTRANET_WEBSITE = true; }, (x: ReturnType<typeof flatchrData>) => { x.props.data.items[0].vacancy.company.id = 'other'; }, (x: ReturnType<typeof flatchrData>) => { x.query.companySlug = 'other'; }, (x: ReturnType<typeof flatchrData>) => { (x.props.data as Record<string, unknown>).next = 2; }]) {
    const v = flatchrData(); mutate(v); assert.throws(() => parseAdditionalListing('flatchr','example',{},flatchrHtml(v)));
  }
  const spontaneous = flatchrData();
  (spontaneous.props.data as Record<string, unknown>).spontaneousV = { ...flatchrJob().vacancy, published: true, id: 'XYZ123', slug: 'xyz123-open-application' };
  assert.equal(parseAdditionalListing('flatchr','example',{},flatchrHtml(spontaneous)).total, 2);
  const closed = flatchrData(); closed.props.data.items[0].published = false;
  assert.equal(parseAdditionalListing('flatchr','example',{},flatchrHtml(closed)).total, 0);
  assert.throws(() => parseAdditionalListing('flatchr','example',{},flatchrHtml().slice(0,-7)));
});

test('Softgarden descriptions use the paced enrichment boundary and retain source input', async () => {
  const job = parseAdditionalListing('softgarden','example.softgarden.io',{},classic()).jobs[0], before = structuredClone(job), requests: string[] = [];
  const result = await enrichAtsListingJob({ platform: 'softgarden', slug: 'example.softgarden.io', job, requestTimeoutMs: 1000 }, {
    safeExternalFetch: async (url) => { requests.push(String(url)); return new Response(classicDetail()); },
    fetchPlatformResponse: async (_p,_s,request,options) => { const response = await request(); await options?.onResponse?.(response); return response; },
    reserveProviderBudgetForSource: async () => ({ allowed: true }), recordProviderSuccess: async () => {}, recordProviderFailure: async () => null,
    passesPreFilter: () => ({ passes: true, reason: '' }),
  });
  const marker = readAtsJobEnrichmentMarker(result);
  assert.equal(marker?.status, 'enriched'); assert.equal(marker.company, 'Example Inc'); assert.match(marker.description || '',/Full responsibilities/);
  assert.equal(requests.length,1); assert.deepEqual(job,before);
});

test('pasted Flatchr vacancy proves its owning company from public detail', async () => {
  const data = flatchrData() as Record<string, unknown>;
  data.page = '/vacancy/[vacancySlug]'; data.query = { vacancySlug: 'abc123-channel-manager' };
  const response = await fetchAdditionalAtsPosting('https://careers.flatchr.io/fr/vacancy/abc123-channel-manager/', async () => new Response(flatchrHtml(data)));
  assert.equal(response?.company, 'Example Inc'); assert.equal(response?.atsSlug, 'example'); assert.match(response?.text || '', /Develop partners/);
});
