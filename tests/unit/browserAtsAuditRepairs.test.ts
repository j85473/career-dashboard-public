import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAtsReader, listingSignature } from '../../src/lib/browserAtsReader';
import { browserPostingLink, type BrowserDocument } from '../../src/lib/browserAtsPosting';
import { newBrowserSweep, loadBrowserSweepPage, advanceBrowserSweep, readBrowserSweep, detachBrowserSweepDetails, browserSweepEnumeratedCount } from '../../src/lib/browserAtsProgress';
import { publicCrawlLaneAllows } from '../../src/lib/browserAtsTransport';
import { parseGustoBoardSnapshot } from '../../src/lib/gustoBoard';
import { readRenderedGustoPage } from '../../src/lib/gustoBrowserPage';

function readerFor(doc: BrowserDocument) {
    const none = { count: async () => 0, nth() { return this; }, filter() { return this; } };
    const frame = { url: () => doc.url, content: async () => doc.html,
        locator: (selector: string) => selector === 'body' ? { innerText: async () => doc.text } : none,
        getByRole: () => none };
    const page = { goto: async () => ({ status: () => 200 }), url: () => doc.url, frames: () => [frame],
        locator: frame.locator, getByRole: () => none, waitForTimeout: async () => {}, close: async () => {} };
    return new BrowserAtsReader({ newPage: async () => page } as never, async () => {});
}

test('the exact Paylocity closure is terminal only for the requested posting, not its board', async () => {
    const board = 'https://recruiting.paylocity.com/recruiting/jobs/All/11111111-1111-1111-1111-111111111111';
    const link = browserPostingLink('paylocity', board, '/Recruiting/Jobs/Details/123', 'Account Manager')!;
    const doc = { url: 'https://recruiting.paylocity.com/recruiting/jobs/JobNotFound',
        html: '<title>Job Not Found</title>', text: "We're sorry, that job does not exist or is not currently active. Powered by Paylocity" };
    assert.equal(await readerFor(doc).detail('paylocity', board, link), null);
    await assert.rejects(readerFor(doc).page('paylocity', board, 1), /public board is unavailable/);
    await assert.rejects(readerFor({ ...doc, text: 'An unrelated error page' }).detail('paylocity', board, link), /lacks a verified/);
});

test('iCIMS browser collection cannot bypass rejected filter or pagination evidence', async () => {
    const board = 'https://careers-example.icims.com/jobs/search?in_iframe=1';
    const html = '<title>Job Listings at Example Inc</title><div class="iCIMS_JobsTable"><div class="iCIMS_JobCardItem"><a href="/jobs/123/account-manager/job"><h3>Account Manager</h3></a></div></div><div class="iCIMS_SearchResultsHeader"><span class="iCIMS_SubHeader_Jobs">Page 1 of 1</span></div>';
    const doc = { url: board, html, text: 'Page 1 of 1 Account Manager' };
    assert.equal((await readerFor(doc).page('icims', board, 1)).links.length, 1);
    for (const rejected of [{ ...doc, url: board + '&searchCategory=8730' },
        { ...doc, html: html.replace('Page 1 of 1', 'Page 1 of 2') },
        { ...doc, html: html.replace('class="iCIMS_SubHeader_Jobs"', '') }]) {
        await assert.rejects(readerFor(rejected).page('icims', board, 1), /catalogue incomplete or filtered/);
    }
});

test('a generic empty search message cannot certify either a first collection or a refresh', async () => {
    const board = 'https://example.avature.net/careers/SearchJobs';
    await assert.rejects(readerFor({ url: board, html: '<p>There are no jobs matching your criteria.</p>',
        text: 'There are no jobs matching your criteria.' }).page('avature', board, 1), /empty state is unverified/);
});

test('Gusto waits past an employer-branded loading shell and retains the later posting', async () => {
    const slug = 'example-8a03dcec-c77a-4fa0-a9fe-438a688b7c6c';
    const shell = '<h1>Example Inc</h1><h2>Open Positions</h2><div>Loading...</div>';
    assert.equal(parseGustoBoardSnapshot(shell, 'Example Inc Open Positions Loading...', slug), null);
    let reads = 0;
    const ready = '<h1>Example Inc</h1><h2>Open Positions</h2><a href="/postings/account-manager-e4a7e88d-ae10-4953-b50c-8bd8dee39a44"><h3>Account Manager</h3><p>Remote</p></a>';
    const page = { content: async () => ++reads === 1 ? shell : ready, locator: () => ({ innerText: async () => '' }) };
    const result = await readRenderedGustoPage(page, (html, text) => parseGustoBoardSnapshot(html, text, slug), 'Board', 1000);
    assert.equal(reads, 2);
    assert.equal(result.postings.length, 1);
    assert.deepEqual(parseGustoBoardSnapshot('<h1>Example Inc</h1><h3>There are no open positions currently</h3>', '', slug), { company: 'Example Inc', postings: [] });
});

test('only a durable detail handoff allows enumeration to continue without claiming the failed detail succeeded', () => {
    const board = 'https://example.freshteam.com/jobs';
    const links = ['1', '2'].map(id => browserPostingLink('freshteam', board, `/jobs/${id}/manager`, 'Manager')!);
    const p = loadBrowserSweepPage(newBrowserSweep(board), { links, total: 3, next: { kind: 'click' }, signature: listingSignature(links) });
    p.offset = 2; p.seen = ['2']; p.detailFailures = [{ id: '1', message: 'Job detail lacks verified evidence' }];
    assert.throws(() => advanceBrowserSweep(p), /every failed posting/);
    const handed = readBrowserSweep(JSON.parse(JSON.stringify(detachBrowserSweepDetails(p))), 'freshteam', board);
    assert.deepEqual(handed.seen, ['2']);
    assert.deepEqual(handed.deferredDetailIds, ['1']);
    assert.equal(browserSweepEnumeratedCount(handed), 2);
    const next = advanceBrowserSweep(handed)!;
    assert.equal(next.page, 2);
    const third = browserPostingLink('freshteam', board, '/jobs/3/manager', 'Manager')!;
    const end = loadBrowserSweepPage(next, { links: [third], total: 3, next: null, signature: listingSignature([third]) });
    end.offset = 1; end.seen.push('3');
    assert.equal(advanceBrowserSweep(end), null);
    assert.deepEqual(end.seen, ['2', '3'], 'failed posting never becomes completed detail evidence');
    assert.deepEqual(end.deferredDetailIds, ['1']);
    assert.equal(publicCrawlLaneAllows('icims', 'http', { status: 'listed', progress: { ...newBrowserSweep('unused'), transport: 'browser-v1' } }), true,
        'the next listing can start independently of browser-owned detail recovery');
});
