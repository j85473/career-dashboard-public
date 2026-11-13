import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { appOnePostingIdentity } from '../../src/lib/apponePostingIdentity';
import { fetchAppOnePosting, parseAppOnePostingHtml, AppOnePostingUnavailableError } from '../../src/lib/apponePosting';
import { ATS_OPTIONS, identifyAts } from '../../src/lib/atsUtils';
import { generatePostingIdentity, isLikelyDuplicatePosting } from '../../src/lib/jobIngestion';
import { urlPostingIdentity } from '../../src/lib/jobUrlReconciliation';
import { readManualImportPage } from '../../src/lib/manualImportPage';
import { planPostingMetadataRepair } from '../../src/lib/postingMetadataRepair';

const url = 'https://www.appone.com/MainInfoReq.asp?R_ID=7193063';
const html = readFileSync(new URL('../fixtures/appone/area-sales-manager-minneapolis.html', import.meta.url), 'utf8');
const title = 'Area Sales Manager II - Minneapolis, MN';

test('AppOne detail and application aliases share exact R_ID identity across tracking and host aliases', () => {
  const identity = generatePostingIdentity({ url });
  assert(identity);
  for (const input of [url, url.replace('www.', ''), url.replace('https:', 'http:'),
    url.replace('MainInfoReq', 'Main') + '&JID=187889&PositionID=858992', url + '&Refer=jobboard',
    url.replace('R_ID', 'r_id')]) {
    const parsed = appOnePostingIdentity(input)!;
    assert.equal(parsed.id, '7193063');
    assert.match(parsed.descriptionUrl, /^https:.*\/MainInfoReq\.asp\?/);
    assert.equal(generatePostingIdentity({ url: input }), identity);
    assert.equal(urlPostingIdentity(input), identity);
    assert.equal(identifyAts({ url: input, manualAts: 'Unknown' }), 'AppOne');
  }
  assert(ATS_OPTIONS.includes('AppOne'));
  assert.notEqual(generatePostingIdentity({ url: url.replace('7193063', '7213567') }), identity);
});

test('unselected, ambiguous, spoofed and unrelated AppOne links have no posting identity', () => {
  for (const input of ['https://www.appone.com', 'https://www.appone.com/Main.asp?JID=187889',
    url + '&R_ID=9999', url + '&r_id=9999', url.replace('7193063', 'no'), url.replace('7193063', '0'),
    url.replace('appone.com', 'appone.com.evil.example'), url.replace('https://', 'https://user@'),
    url.replace('.com/', '.com:8443/'), url.replace('MainInfoReq.asp', 'EmailFriend.aspx')]) {
    assert.equal(appOnePostingIdentity(input), null, input);
    assert.equal(urlPostingIdentity(input), null, input);
  }
});

test('actual AppOne table yields clean job text and the role location rather than employer HQ', () => {
  const posting = parseAppOnePostingHtml(html, url)!;
  assert.equal(posting.ats, 'AppOne');
  assert.equal(posting.title, title);
  assert.equal(posting.company, 'Electrolit USA');
  assert.equal(posting.location, 'Minneapolis, MN');
  assert.match(posting.text, /CAB Enterprises, Inc\./);
  assert.match(posting.text, /Minimum three \(3\) years of sales experience/);
  assert.match(posting.text, /Travel at least 90%/);
  assert.match(posting.text, /Full-Time\/Part-Time\nFull-Time/);
  assert.match(posting.text, /• Partner with local distributors/);
  assert.doesNotMatch(posting.text, /WE ALSO RECOMMEND|San Jose|Corporate Paralegal|technical assistance|Privacy Policy|cookies|Apply Now|Job Information:/i);
  assert.match(posting.text, /Principal Duties\n/);
});

test('role-specific location outranks generic Field and Houston metadata even without the region label', () => {
  const withoutRegion = html.replaceAll('<strong>Location/Region</strong>: Minneapolis, MN', 'Sales territory includes the metro area');
  assert.equal(parseAppOnePostingHtml(withoutRegion, url)?.location, 'Minneapolis, MN');
});

test('AppOne preserves separate requirements and pay fields without counting legal boilerplate as a JD', () => {
  const $ = cheerio.load(html);
  const descriptionCell = $('td.smallheader').filter((_, node) => $(node).text().trim() === 'Description').next('td');
  const requirementsCell = $('td.smallheader').filter((_, node) => $(node).text().trim() === 'Position Requirements').next('td');
  descriptionCell.html('<p>Manage existing distributor accounts and develop territory sales.</p>');
  assert.equal(parseAppOnePostingHtml($.html(), url), null, 'A short description plus long EOE/about-us text is incomplete');
  requirementsCell.html('<p>Minimum three years of beverage sales experience required. Manage accounts, plan store visits and train distributor teams.</p>'.repeat(8));
  $('table#JobDescription > tbody').append('<tr><td>Salary Range</td><td>$80,000–$100,000 annually</td></tr>');
  const posting = parseAppOnePostingHtml($.html(), url)!;
  assert.match(posting.text, /Manage existing distributor accounts/);
  assert.match(posting.text, /Position Requirements\nMinimum three years/);
  assert.match(posting.text, /Salary Range\n\$80,000–\$100,000 annually/);
});

test('a sibling requisition, conflicting page title, form, closed page or incomplete JD cannot supply this job', () => {
  for (const page of [html.replace("name='R_ID' value='7193063'", "name='R_ID' value='9999999'"),
    html.replace("action='Main.asp?JID=187889&B_ID=91&Lo_ID=599869&R_ID=7193063", "action='Main.asp?R_ID=9999999"),
    html.replace('itemprop="title" content="' + title, 'itemprop="title" content="Wrong role'),
    html.replace('This position is currently accepting applications.', 'This position is no longer accepting applications.'),
    html.replace('id="JobDescription"', 'id="OtherJob"'),
    html.replace('itemprop="hiringOrganization" content="Electrolit USA"', 'itemprop="hiringOrganization" content="Unknown Company"'),
    '<table id="JobDescription"><tr><td>Description</td><td>Loading...</td></tr></table>']) {
    assert.equal(parseAppOnePostingHtml(page, url), null);
  }
  assert.equal(parseAppOnePostingHtml(html, url.replace('7193063', '9999999')), null);
  assert.equal(parseAppOnePostingHtml(html, url.replace('MainInfoReq', 'Main')), null, 'Application forms cannot become descriptions');
});

test('public fetch reads the description URL even for an application link', async () => {
  const input = url.replace('MainInfoReq', 'Main') + '&JID=187889&PositionID=858992';
  const posting = await fetchAppOnePosting(input, async target => {
    assert.equal(String(target), appOnePostingIdentity(input)?.descriptionUrl);
    assert.equal(new URL(String(target)).pathname, '/MainInfoReq.asp');
    return new Response(html);
  });
  assert.equal(posting.title, title);
  assert.equal(posting.location, 'Minneapolis, MN');
  assert.equal(posting.postingVerificationError, undefined);
});

test('unavailable reads return a verification failure instead of falling through to whole-page text', async () => {
  for (const fetcher of [async () => new Response(html, { status: 404 }), async () => new Response('<h1>Apply now</h1>'),
    async () => { throw new Error('timeout'); }, async () => {
      const response = new Response(html);
      Object.defineProperty(response, 'url', { value: url.replace('7193063', '9999999') });
      return response;
    }, async () => {
      const response = new Response(html);
      Object.defineProperty(response, 'url', { value: url.replace('appone.com', 'evil.example') });
      return response;
    }]) {
    const result = await fetchAppOnePosting(url, fetcher);
    assert.match(result.postingVerificationError!, /AppOne did not return verified/);
    assert.equal(result.text, '');
  }
  const invalid = await fetchAppOnePosting('https://www.appone.com', async () => assert.fail('No request without R_ID'));
  assert(invalid.postingVerificationError);
});

test('manual HTML fallback uses AppOne fields without inference and rejects unverified forms', async () => {
  const imported = await readManualImportPage({ html, url }, async () => assert.fail('Published fields do not need a model'));
  assert.equal(imported.title, title);
  assert.equal(imported.company, 'Electrolit USA');
  assert.equal(imported.location, 'Minneapolis, MN');
  assert.doesNotMatch(imported.description, /WE ALSO RECOMMEND|cookies/);
  const supplied = await readManualImportPage({ html, url, title: 'Reviewed title', company: 'Reviewed employer' }, async () => assert.fail());
  assert.equal(supplied.title, 'Reviewed title');
  assert.equal(supplied.company, 'Reviewed employer');
  await assert.rejects(readManualImportPage({ html, url: url.replace('MainInfoReq', 'Main') }, async () => assert.fail()), AppOnePostingUnavailableError);
});

test('same-title AppOne requisitions stay distinct while application aliases match', () => {
  const job = { title, company: 'Electrolit USA', location: 'Minneapolis, MN', description: '', url, source: 'Manual Import' };
  assert.equal(isLikelyDuplicatePosting(job, { ...job, url: url.replace('7193063', '7213567') }), false);
  assert.equal(isLikelyDuplicatePosting(job, { ...job, url: url.replace('MainInfoReq', 'Main') + '&PositionID=858992' }), true);
});

test('reimport can repair the old AppOne page-title wrapper without changing decisions or scores', () => {
  const job = { title: `Job Information: ${title} Job`, company: 'Unknown Company', location: null, url,
    source: 'Manual Import', status: 'applied', passReason: null, scoringStatus: 'scored', tailoringStaged: true };
  const evidence = { title, company: 'Electrolit USA', location: 'Minneapolis, MN', source: 'AppOne', identityVerified: true, completeLocations: true };
  const repair = planPostingMetadataRepair(job, evidence, { hasScores: true, hasHumanDecision: true });
  assert.deepEqual(repair, { action: 'metadata_only', metadata: { title, company: 'Electrolit USA', employer: 'Electrolit USA', location: 'Minneapolis, MN' } });
  assert.equal(planPostingMetadataRepair(job, { ...evidence, title: 'Other role' }, { hasScores: true, hasHumanDecision: true }), null);
});
