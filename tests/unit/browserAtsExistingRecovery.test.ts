import test from 'node:test';
import assert from 'node:assert/strict';
import { browserAtsBoardFromUrl } from '../../src/lib/browserAtsBoards';
import { browserPostingLink, parseBrowserPosting } from '../../src/lib/browserAtsPosting';
import { BrowserAtsReader, postingLinksFromDocuments, verifiedEmptyBoard } from '../../src/lib/browserAtsReader';
import { taleoSearchPage } from '../../src/lib/browserTaleoEvidence';
import { assertPublicBoardAvailable, PublicBoardUnavailableError } from '../../src/lib/publicBoardAvailability';
import { browserCrawlRetry } from '../../src/lib/browserAtsRetry';

test('a verified Avature employer-domain redirect retains the original board and requisition identity', () => {
  const board = 'https://advocateaurorahealth.avature.net/careers/SearchJobs';
  const url = 'https://clinicianjobs.advocatehealth.org/careers/JobDetail/Cardiac-Anesthesiology-Milwaukee-WI/19943';
  assert.equal(browserAtsBoardFromUrl('avature', url), board);
  const link = browserPostingLink('avature', board, url, 'Cardiac Anesthesiology')!;
  assert.equal(link.id, '19943');
  const doc = { url: url.replace('/JobDetail/Cardiac-Anesthesiology-Milwaukee-WI/19943', '/SearchJobs'), text: '', html: `<h3 class="article__header__text__title"><a class="link_result" href="${url}">Cardiac Anesthesiology</a></h3>` };
  assert.equal(postingLinksFromDocuments('avature', board, [doc])[0].id, '19943');
  for (const changed of [url.replace('clinicianjobs.advocatehealth.org', 'jobs.other.example'), url.replace('clinicianjobs.advocatehealth.org', 'clinicianjobs.advocatehealth.org.evil.example'), url.replace('/careers/', '/other/')]) {
    assert.equal(browserPostingLink('avature', board, changed), null);
  }
  const description = 'Lead patient services, coordinate partners and deliver clinical care. '.repeat(8);
  const detail = { url, text: description, html: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Cardiac Anesthesiology', hiringOrganization: { name: 'Advocate Health' }, description })}</script>` };
  assert.equal(parseBrowserPosting('avature', board, link, [detail])?.company, 'Advocate Health');
});

const brassring = 'https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=13900&siteid=5007';
const emptyBrassring = {
  url: brassring + '#keyWordSearch=&locationSearch=', text: 'Det finns inga jobb som matchar dina kriterier',
  html: `<div id="gateway" class="searchResults"><input type="hidden" id="searchResults" value='{"TotalCount":0,"HotJobs":{"Job":null}}'><h2 id="noJobsAlert">Det finns inga jobb som matchar dina kriterier</h2></div>`,
};
test('localized BrassRing empty results need an active unfiltered search and the publisher zero count', () => {
  assert.equal(verifiedEmptyBoard('brassring', [emptyBrassring], brassring), true);
  for (const doc of [{ ...emptyBrassring, url: brassring + '#home' }, { ...emptyBrassring, url: brassring + '#keyWordSearch=Sales&locationSearch=' },
    { ...emptyBrassring, html: emptyBrassring.html.replace('"TotalCount":0', '"TotalCount":10') }, { ...emptyBrassring, html: emptyBrassring.html.replace('class="searchResults"', '') },
    { ...emptyBrassring, html: emptyBrassring.html.replace('id="noJobsAlert"', 'id="noJobsAlert" hidden') }, { ...emptyBrassring, text: '' }]) {
    assert.equal(verifiedEmptyBoard('brassring', [doc], brassring), false);
  }
});

test('BrassRing activates the publisher search button independently of its translated label', async () => {
  let searched = false;
  const none = { count: async () => 0, nth() { return this; }, filter() { return this; } };
  const control = { count: async () => 1, nth() { return this; }, isVisible: async () => true, isDisabled: async () => false, getAttribute: async () => null, click: async () => { searched = true; } };
  const locator = (selector: string) => selector === 'body' ? { innerText: async () => searched ? emptyBrassring.text : 'Sök' }
    : selector === 'button#clearResumeJobsBtn[ng-click="searchMatchedJobs(this)"]' ? control : none;
  const frame = { url: () => searched ? emptyBrassring.url : brassring, content: async () => searched ? emptyBrassring.html : '<button id="clearResumeJobsBtn" ng-click="searchMatchedJobs(this)">Sök</button>', locator, getByRole: () => none };
  const page = { on: () => {}, goto: async () => ({ status: () => 200 }), url: frame.url, frames: () => [frame], locator,
    getByRole: () => { throw Error('Localized search must not depend on English'); }, waitForTimeout: async () => {}, close: async () => {} };
  const reader = new BrowserAtsReader({ newPage: async () => page } as never, async () => {});
  const result = await reader.page('brassring', brassring, 1);
  assert.equal(searched, true);
  assert.equal(result.emptyVerified, true);
  assert.equal(result.total, 0);
  await reader.close();
});

const taleo = 'https://aa010.taleo.net/careersection/swd_summer_internship/jobsearch.ftl';
const request = { pageNo: 1, fieldData: { fields: { KEYWORD: '', LOCATION: '' }, valid: true }, filterSelectionParam: { searchFilterSelections: [] }, advancedSearchFiltersSelectionParam: { searchFilterSelections: [] } };
const responseUrl = 'https://aa010.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal=101';
const response = { careerSectionUnAvailable: false, pagingData: { currentPageNo: 1, pageSize: 25, totalCount: 0 }, requisitionList: [], queryString: 'f=null&s=3|D&a=null&page=1&multiline=false' };
test('Taleo empty sections require an exact unfiltered public response, matching portal and rendered empty state', () => {
  const evidence = taleoSearchPage(taleo, responseUrl, request, response)!;
  assert.ok(evidence);
  const doc = { url: taleo, html: '<script>var settings={portalNo:"101"};</script><div id="noResults"><p class="no-results-info">No jobs correspond to the specified criteria.</p></div>', text: 'The list of jobs has reloaded. 1 – 0 of 0. Page 1\nNo jobs correspond to the specified criteria.' };
  assert.equal(verifiedEmptyBoard('taleo', [doc], taleo, evidence), true);
  assert.equal(verifiedEmptyBoard('taleo', [doc], taleo), false);
  assert.equal(verifiedEmptyBoard('taleo', [{ ...doc, html: doc.html.replace('101', '102') }], taleo, evidence), false);
  assert.equal(verifiedEmptyBoard('taleo', [{ ...doc, html: doc.html.replace('id="noResults"', 'id="noResults" style="display: none"') }], taleo, evidence), false);
  assert.equal(taleoSearchPage(taleo, responseUrl, { ...request, fieldData: { valid: true, fields: { KEYWORD: 'sales' } } }, response), null);
  assert.equal(taleoSearchPage(taleo, responseUrl, request, { ...response, pagingData: { ...response.pagingData, totalCount: 10 } }), null);
});

test('Jobvite unavailable redirects and Talemetry security pages defer without pretending to be empty employers', () => {
  const support = { url: 'https://www.jobvite.com/support/job-seeker-support/?invalid=1', html: '<h1>Job Seeker Support</h1>', text: 'Job Seeker Support' };
  assert.throws(() => assertPublicBoardAvailable('jobvite', support), PublicBoardUnavailableError);
  try { assertPublicBoardAvailable('jobvite', support); } catch (error) { assert.equal(browserCrawlRetry((error as Error).message, 0).kind, 'unavailable'); }
  assert.equal(verifiedEmptyBoard('jobvite', [support], 'https://jobs.jobvite.com/1901group/jobs'), false);
  const challenge = { url: 'https://adr-careers.ttcportals.com/search/jobs', html: '<script src="/cdn-cgi/challenge-platform/x"></script><h1>Performing security verification</h1>', text: 'Performing security verification' };
  assert.throws(() => assertPublicBoardAvailable('talemetry', challenge), PublicBoardUnavailableError);
  try { assertPublicBoardAvailable('talemetry', challenge); } catch (error) { assert.equal(browserCrawlRetry((error as Error).message, 0).kind, 'access'); }
  assert.equal(verifiedEmptyBoard('talemetry', [challenge], challenge.url), false);
  assert.doesNotThrow(() => assertPublicBoardAvailable('talemetry', { ...challenge, html: '<h1>Security verification specialist</h1>', text: 'Security verification specialist' }));
});
