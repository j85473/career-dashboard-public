import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { adpMyJobsIdentity, fetchAdpMyJobsPosting, parseAdpMyJobsPosting } from '../../src/lib/adpMyJobsPosting';
import { assessJobDescriptionQuality } from '../../src/lib/jobDescriptionQuality';
import { postingRefreshDescription } from '../../src/lib/postingMetadata';

const url = 'https://myjobs.adp.com/800flowerscareers/cx/job-details?rb=INDEED&reqId=5001237399306';
const site = { domain: '800flowerscareers', active: true, clientName: '1-800-Flowers Family of Brands',
  settings: { externalId: '897941', careerSiteType: 'External' }, myJobsToken: 'public-site-token' };
const fixture = JSON.parse(readFileSync(new URL('../fixtures/adp/myjobs-grocery-sales.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(fixture);

test('new ADP public API supplies Atlanta and both duties and separately published requirements', async () => {
  const calls: string[] = [];
  const posting = await fetchAdpMyJobsPosting(url, async (target, init) => {
    const path = String(target); calls.push(path);
    if (calls.length === 1) {
      assert.equal(path, 'https://myjobs.adp.com/public/staffing/v1/career-site/800flowerscareers');
      return Response.json(site);
    }
    assert.equal(path, 'https://my.adp.com/myadp_prefix/mycareer/public/staffing/v1/job-requisitions/search-meta/5001237399306');
    assert.equal(new Headers(init?.headers).get('myJobsToken'), site.myJobsToken);
    assert.equal(init?.redirect, 'error');
    return Response.json(fixture);
  });
  assert.equal(calls.length, 2);
  assert.equal(posting.location, 'Atlanta, Georgia, United States');
  assert.equal(posting.title, 'Customer Experience Manager, Grocery & Distributor Sales');
  assert.match(posting.text, /Serve as a primary day-to-day contact/);
  assert.match(posting.text, /3–5\+ years/);
  assert.match(posting.text, /fully remote environment/);
  assert.match(posting.text, /approximately 25%/);
  assert.match(posting.text, /Preferred Qualifications/);
  assert.equal(assessJobDescriptionQuality(posting.text, { structuredSource: true }).scorable, true);
  assert.equal(posting.postingVerificationError, undefined);
});

test('new ADP identities reject unrelated hosts, credentials, ports, ambiguous IDs and careers listings', () => {
  assert.deepEqual(adpMyJobsIdentity(url), { site: '800flowerscareers', id: '5001237399306' });
  for (const invalid of [url.replace('https:', 'http:'), url.replace('.com/', '.com.evil.example/'),
    url.replace('myjobs.adp.com', 'user@myjobs.adp.com'), url.replace('.com/', '.com:444/'),
    url + '&reqId=1', url.replace('reqId=5001237399306', 'reqId=bad'), url.replace('job-details', 'job-listing')]) {
    assert.equal(adpMyJobsIdentity(invalid), null, invalid);
  }
});

test('exact requisition and published career-site membership are mandatory', () => {
  const wrongId = clone(); wrongId.jobRequisitions[0].itemID = 999;
  const wrongSite = clone(); wrongSite.jobRequisitions[0].postingInstructions[0].postingChannel.channelID = '999';
  const multiple = clone(); multiple.jobRequisitions.push(multiple.jobRequisitions[0]);
  for (const body of [wrongId, wrongSite, multiple, {}, null, { jobRequisitions: [null] }]) {
    assert.equal(parseAdpMyJobsPosting(body, url, site), null);
  }
  for (const config of [{ ...site, domain: 'other' }, { ...site, active: false },
    { ...site, settings: { ...site.settings, careerSiteType: 'Internal' } }]) {
    assert.equal(parseAdpMyJobsPosting(fixture, url, config), null);
  }
});

test('all published sites survive, while unpublished addresses are excluded', () => {
  const body = clone();
  body.jobRequisitions[0].requisitionLocations.push({ postingIndicator: true, address: { cityName: 'Medford', countrySubdivisionLevel1: { longName: 'Oregon' } } },
    { postingIndicator: false, address: { cityName: 'Private office' } });
  assert.equal(parseAdpMyJobsPosting(body, url, site)?.location, 'Atlanta, Georgia, United States; Medford, Oregon');
});

test('blocked, redirected or mismatched ADP reads return a verification failure that prevents generic fallback', async () => {
  for (const failure of ['blocked', 'redirect', 'invalid-json', 'wrong-job', 'config-redirect', 'other-config']) {
    let count = 0;
    const result = await fetchAdpMyJobsPosting(url, async () => {
      count++;
      if (failure === 'blocked') return new Response('', { status: 403 });
      if (failure === 'invalid-json') return new Response('not JSON');
      const body = count === 1 ? (failure === 'other-config' ? { ...site, domain: 'other' } : site)
        : failure === 'wrong-job' ? { jobRequisitions: [] } : fixture;
      const response = Response.json(body);
      if (failure === 'redirect' && count === 2 || failure === 'config-redirect' && count === 1)
        Object.defineProperty(response, 'url', { value: 'https://other.example/data' });
      return response;
    });
    assert.ok(result.postingVerificationError, failure);
    assert.equal(result.text, '', failure);
  }
});

const privacy = `800 Flowers Careers\nSign in\nEmployer Privacy Policy\n
Categories of Personal Information We Collect\nWe collect employment history, education information and device location information.\n
How We Use Your Personal Information\nWe manage your preferences and process business information for applicants.\n
How Long We Retain Your Personal Information\nWe retain applications and employment records as required by law.\n
${'Categories of Sources. Service providers, recruiters, employment references and publicly available sources. '.repeat(30)}\nSet your cookie preferences\nPowered by ADP`;

test('a lengthy applicant privacy page cannot overwrite the JD even though it contains employment vocabulary', () => {
  for (const structuredSource of [true, false]) {
    assert.equal(assessJobDescriptionQuality(privacy, { structuredSource }).scorable, false);
    assert.deepEqual(postingRefreshDescription({ description: privacy, structuredSource, existingDescription: 'Original verified job evidence',
      preserveScores: true, metadata: { company: 'Actual employer', location: 'Atlanta, GA' } }),
    { description: 'Original verified job evidence', verified: false });
  }
  const actual = parseAdpMyJobsPosting(fixture, url, site)!;
  assert.equal(assessJobDescriptionQuality(actual.text + '\n' + privacy).scorable, true);
  assert.equal(assessJobDescriptionQuality("You'll build relationships with distributor partners and grow established accounts. ".repeat(25) + '\n' + privacy).scorable, true);
});
