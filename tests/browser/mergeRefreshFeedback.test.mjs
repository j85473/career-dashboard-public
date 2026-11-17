// Exercise the real merge screen while holding the external refresh response.
// All API writes use fixtures; no saved Dashboard cards are changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const job = { id: 'inbox', title: 'Dealer Development Manager', company: 'Employer',
  status: 'inbox', location: 'Minneapolis, MN', source: 'JSearch', description: 'Original posting details.',
  scoreAuthorityState: 'current', aimFitScore: 88, reqFitScore: 78 };
const survivor = { ...job, id: 'applied', status: 'applied', title: 'Region Dealer Development Manager',
  aimFitScore: 91, reqFitScore: 76, url: 'https://employer.example/jobs/1' };
const score = value => ({ value, mode: 'preserved', sources: [] });
const plan = { survivorId: survivor.id, redundantId: job.id, survivorStatus: survivor.status,
  survivorReason: 'Keep the selected Applied card.', blockedReason: null,
  aim: score(91), experience: score(76) };

test('saved merge is visible before posting refresh, including failures and closing the card', async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ExpandOverlay} from './src/components/ExpandOverlay';
    window.updates=[];
    function App(){const [open,setOpen]=useState(true);const [selected,setSelected]=useState(${JSON.stringify(job)});
      return open?<ExpandOverlay job={selected} onClose={()=>setOpen(false)} onCompanySelect={()=>{}}
        onStatusChange={()=>{throw Error('Unexpected status change')}}
        onJobUpdate={(id,update)=>{window.updates.push({id,update});setSelected(old=>old.id===id?{...old,...update}:old)}}/>:<p>Card closed</p>}
    createRoot(document.getElementById('root')).render(<App/>);`,
    resolveDir: root, loader: 'tsx' }, bundle: true, write: false, platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'fixture', setup(builder) {
      builder.onResolve({ filter: /\/atsUtils$/ }, () => ({ path: 'ats', namespace: 'fixture' }));
      builder.onResolve({ filter: /\/modal$/ }, () => ({ path: 'modal', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'ats'
        ? 'export const ATS_OPTIONS=["Workday"];export const identifyAts=()=>"Workday";'
        : 'export const showOptions=async()=>window.refreshChoice||"link_only";export const showAlert=async()=>{};export const showConfirm=async()=>false;' }));
    } }],
  });
  const css = await readFile(`${root}/src/app/globals.css`, 'utf8');
  const server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
    for (const scenario of ['success', 'http failure', 'network failure', 'warning', 'rescore', 'close']) {
      await t.test(scenario, async () => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = []; const writes = []; const reads = [];
        let mergeRoute, refreshRoute;
        let currentSurvivor = survivor;
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) return route.abort();
          if (!url.pathname.startsWith('/api/')) return route.continue();
          if (route.request().method() !== 'GET') {
            writes.push({ path: url.pathname, body: route.request().postDataJSON() });
            if (url.pathname === '/api/jobs/inbox/scrape') return route.fulfill({ status: 409, json: { mergeTargetJobId: survivor.id } });
            if (url.pathname === '/api/jobs/inbox/merge') { mergeRoute = route; return; }
            if (url.pathname === '/api/jobs/applied/scrape') { refreshRoute = route; return; }
            throw Error(`Unexpected mutation ${url.pathname}`);
          }
          reads.push(url.pathname);
          if (url.pathname === '/api/jobs/inbox') return route.fulfill({ json: { job } });
          if (url.pathname === '/api/jobs/applied') return route.fulfill({ json: { job: currentSurvivor } });
          if (url.pathname === '/api/jobs/inbox/merge') return route.fulfill({ json: {
            cards: [job, survivor], plan, selectionPlans: { inbox: plan, applied: plan },
          } });
          return route.fulfill({ json: { copies: [], repeats: [], attachments: [] } });
        });
        await page.goto(origin);
        if (scenario === 'rescore') await page.evaluate(() => { window.refreshChoice = 'scrape_score'; });
        await page.getByPlaceholder('Paste Direct URL...').fill(survivor.url);
        await page.getByRole('button', { name: 'Scrape', exact: true }).click();
        await page.getByRole('heading', { name: 'Review these two cards' }).waitFor();
        await page.getByRole('button', { name: 'Merge these cards', exact: true }).click();
        await page.getByRole('button', { name: 'Merging…', exact: true }).waitFor();
        assert.equal(await page.locator('.merge-complete-notice').count(), 0, 'do not announce success before the merge commits');
        await mergeRoute.fulfill({ json: { job: survivor, consolidatedJobId: job.id } });
        const notice = page.locator('.merge-complete-notice');
        await notice.getByText('Refreshing posting details… You can close this card.').waitFor();
        assert.match(await notice.innerText(), /Merged into the applied card/);
        assert.equal(await page.getByRole('heading', { name: 'Review these two cards' }).count(), 0);
        assert.equal(await page.locator('#job-dialog-title').innerText(), survivor.title);
        assert.equal(await page.getByRole('button', { name: 'Scrape', exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Edit JD', exact: true }).isDisabled(), true);
        assert.equal(await page.getByTitle('Edit Title/Company', { exact: true }).isDisabled(), true);
        assert.deepEqual((await page.evaluate(() => window.updates)).map(item => item.id), ['inbox', 'applied'], 'both cards update while the refresh is still pending');
        assert.deepEqual(writes[2], { path: '/api/jobs/applied/scrape', body: {
          url: survivor.url, linkOnly: scenario !== 'rescore', skipRescore: scenario !== 'rescore',
        } });
        if (scenario === 'success') {
          await page.setViewportSize({ width: 390, height: 844 });
          await notice.scrollIntoViewIfNeeded();
          const size = await notice.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
          assert.ok(size.scroll <= size.width + 1, 'the separate refresh status wraps on mobile');
          await page.screenshot({ path: '/tmp/career-merge-refresh-pending-mobile.png', fullPage: true });
          await page.setViewportSize({ width: 1440, height: 1000 });
        }
        const refreshedJob = { ...survivor, description: 'Fresh posting details.' };
        currentSurvivor = refreshedJob;
        if (scenario === 'close') {
          await page.getByRole('button', { name: 'Close job details' }).click();
          await page.getByText('Card closed', { exact: true }).waitFor();
          const response = page.waitForResponse(response => response.url().endsWith('/api/jobs/applied/scrape'));
          await refreshRoute.fulfill({ json: { job: refreshedJob } });
          await response;
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
          assert.equal((await page.evaluate(() => window.updates)).length, 2, 'a late refresh cannot overwrite subsequent Dashboard actions after closing');
        } else {
          if (scenario === 'network failure') await refreshRoute.abort();
          else await refreshRoute.fulfill({ status: scenario === 'http failure' ? 500 : 200, json:
            scenario === 'http failure' ? { error: 'Posting refresh timed out.' }
              : scenario === 'warning' ? { job: survivor, refreshWarning: 'Link saved, but details were unavailable.' }
                : { job: refreshedJob, rescoreQueued: scenario === 'rescore' } });
          const expected = { success: 'Posting details refreshed. Scores were preserved.',
            rescore: 'Posting details refreshed. A rescore was requested.',
            'http failure': 'Posting refresh timed out.',
            'network failure': 'The posting details could not be refreshed. Your merge and link are saved. Retry the details refresh.',
            warning: 'Link saved, but details were unavailable.' }[scenario];
          await notice.getByText(expected, { exact: true }).waitFor();
          assert.match(await notice.innerText(), /Merged into the applied card/, 'refresh failure cannot replace merge success');
          assert.equal(await notice.locator('.animate-spin').count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Scrape', exact: true }).isEnabled(), true);
          if (scenario !== 'rescore') assert.doesNotMatch(await notice.innerText(), /rescore was requested/);
          if (scenario === 'success') {
            await page.getByText(refreshedJob.description, { exact: true }).waitFor();
            const polling = page.waitForRequest(request => request.url() === `${origin}/api/jobs/applied`);
            await page.evaluate(() => window.dispatchEvent(new Event('dashboardDataRefresh')));
            await polling;
            assert.equal(reads.filter(path => path === '/api/jobs/inbox').length, 1, 'poll the surviving card, never the dismissed original');
            await page.screenshot({ path: '/tmp/career-merge-refresh-complete.png', fullPage: true });
          }
        }
        assert.deepEqual(errors, []);
        await page.close();
      });
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
