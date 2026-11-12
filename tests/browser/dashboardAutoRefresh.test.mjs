// Real Dashboard with fixture APIs: no production records are read or changed.
// PLAYWRIGHT_BROWSER=webkit exercises Safari's engine.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
let server, browser, origin;
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';
      import Dashboard from './src/components/Dashboard';
      import {startDashboardAutoRefresh} from './src/lib/dashboardAutoRefresh';
      function App(){useEffect(()=>startDashboardAutoRefresh({version:'build-a',reload:()=>{window.reloadCount=(window.reloadCount||0)+1}}),[]);
        return <Dashboard/>}createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'navigation-fixture', setup(builder) {
      builder.onResolve({ filter: /^node:zlib$/ }, args => ({ path: args.path, external: true, sideEffects: false }));
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const usePathname=()=>"/";export const useSearchParams=()=>new URLSearchParams(window.location.search);' }));
    } }],
  });
  const css = await readFile(`${root}/src/app/globals.css`, 'utf8');
  server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await (process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function fixture({ tab = 'interviewing', count = 1, company = false, mobile = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 }, timezoneId: 'America/Chicago' });
  context.setDefaultTimeout(5_000);
  const page = await context.newPage();
  await page.clock.install({ time: new Date('2026-11-12T18:00:00Z') });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const jobs = Array.from({ length: count }, (_, i) => ({
    id: `job-${i}`, title: `Account Manager ${i}`, company: 'Example', status: tab === 'log' ? 'pending_ef' : tab,
    scoreAuthorityState: 'current', aimFitScore: 85, reqFitScore: 81, interviews: [],
    description: 'Manage partners and grow accounts.', url: 'https://example.invalid/job',
  }));
  const state = { version: 'build-a', jobs, calls: [], fail: false, hold: null, release: null, writing: null };
  await page.addInitScript(tab => { localStorage.setItem('activeTab', tab); localStorage.setItem('activeLogTab', 'experience_fit'); }, tab);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    state.calls.push({ path: url.pathname, page: Number(url.searchParams.get('page')), method: request.method() });
    const json = body => route.fulfill({ json: body });
    if (url.pathname === '/api/version') return json({ version: state.version });
    if (url.pathname === '/api/company-logo') return route.fulfill({ status: 404, body: '' });
    if (url.pathname === '/api/pipeline/status') return json({ isRunning: false });
    if (url.pathname === '/api/ats-companies') return json({ companies: [], platforms: [] });
    if (url.pathname === '/api/scoring/runs') return json({ runs: [] });
    if (url.pathname === '/api/scoring/batches') return json({ batches: [] });
    if (url.pathname === '/api/pipeline/ats-queues') return route.fulfill({ status: 503, json: {} });
    if (url.pathname.endsWith('/jd-pdf')) return json({ capture: null, attachments: [] });
    if (url.pathname.endsWith('/combined')) return json({ copies: [] });
    if (url.pathname.endsWith('/repeats')) return json({ repeats: [] });
    if (url.pathname === '/api/fixture-save') {
      await new Promise(resolve => { state.writing = resolve; });
      return json({ saved: true });
    }
    if (url.pathname === '/api/jobs' || url.pathname === '/api/jobs/search') {
      const p = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 48);
      const status = url.searchParams.get('status');
      const selected = company || url.pathname.endsWith('/search') ? state.jobs : state.jobs.filter(job => status === 'log' ? job.status === 'pending_ef' : job.status === status);
      const result = { jobs: structuredClone(selected.slice((p - 1) * limit, p * limit)), atsOptions: [],
        pagination: { page: p, limit, total: selected.length, totalPages: Math.max(1, Math.ceil(selected.length / limit)), hasMore: p * limit < selected.length } };
      if (state.hold) await state.hold;
      if (state.fail) return route.fulfill({ status: 503, json: { error: 'Temporarily offline' } });
      return json(result);
    }
    const job = state.jobs.find(job => url.pathname === `/api/jobs/${job.id}`);
    if (job) return json({ job });
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  });
  await page.goto(company ? `${origin}/?company=Example` : origin);
  await page.waitForFunction(expected => document.querySelectorAll('.job-card, .log-job-row').length === expected, Math.min(count, tab === 'log' ? 50 : 48));
  const advance = async (ms = 20_000) => { await page.clock.runFor(ms); await page.waitForTimeout(50); };
  return { context, page, state, errors, advance };
}

for (const tab of ['inbox', 'applied', 'interviewing', 'log']) {
  test(`${tab} quietly picks up outside changes while the pipeline is idle`, async () => {
    const f = await fixture({ tab });
    try {
      f.state.jobs[0].title = 'Updated externally';
      f.state.jobs[0].aimFitScore = 93;
      f.state.jobs[0].interviews = [{ id: 'round-1', scheduledAt: '2026-11-13T15:30:00Z', endsAt: '2026-11-13T16:00:00Z', label: 'Hiring manager' }];
      f.state.jobs.push({ ...f.state.jobs[0], id: 'new', title: 'New outside job' });
      await f.advance();
      if (tab === 'log') {
        await f.page.getByText('Updated externally', { exact: true }).waitFor();
        await f.page.getByText('New outside job', { exact: true }).waitFor();
      } else {
        await f.page.getByRole('button', { name: 'Open Updated externally at Example', exact: true }).waitFor();
        await f.page.getByRole('button', { name: 'Open New outside job at Example', exact: true }).waitFor();
      }
      assert.equal(await f.page.locator('.job-card, .log-job-row').count(), 2);
      if (tab === 'interviewing') await f.page.getByText('Hiring manager', { exact: true }).first().waitFor();
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
}

for (const mobile of [false, true]) test(`${mobile ? 'mobile' : 'desktop'} retains loaded pages, visible card position, and mounted cards`, async () => {
  const f = await fixture({ tab: 'applied', count: 120, mobile });
  try {
    await f.page.getByRole('button', { name: /^Load more/ }).click();
    await f.page.waitForFunction(() => document.querySelectorAll('.job-card').length === 96);
    await f.page.locator('[data-job-id="job-65"]').scrollIntoViewIfNeeded();
    await f.page.evaluate(() => { window.savedCard = document.querySelector('[data-job-id="job-65"]'); });
    const before = await f.page.locator('[data-job-id="job-65"]').evaluate(el => el.getBoundingClientRect().top);
    f.state.jobs.unshift({ ...f.state.jobs[0], id: 'inserted', title: 'Inserted above reading position' });
    await f.advance();
    await f.page.getByRole('button', { name: 'Open Inserted above reading position at Example', exact: true }).waitFor();
    await f.page.waitForFunction(() => document.querySelectorAll('.job-card').length === 96);
    assert.equal(await f.page.evaluate(() => window.savedCard === document.querySelector('[data-job-id="job-65"]')), true);
    const after = await f.page.locator('[data-job-id="job-65"]').evaluate(el => el.getBoundingClientRect().top);
    assert.ok(Math.abs(after - before) <= 2, `visible card moved ${after - before}px`);
    assert.ok(f.state.calls.filter(call => call.path === '/api/jobs' && call.page === 2).length >= 2, 'both loaded pages refresh');
  } finally { await f.context.close(); }
});

test('focus and Safari page restoration immediately refresh without duplicate requests', async () => {
  const f = await fixture();
  try {
    await f.advance(600);
    const callsBefore = f.state.calls.filter(call => call.path === '/api/jobs').length;
    f.state.jobs[0].title = 'Changed while away';
    await f.page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange')); });
    await f.page.getByRole('button', { name: 'Open Changed while away at Example', exact: true }).waitFor();
    assert.equal(f.state.calls.filter(call => call.path === '/api/jobs').length, callsBefore + 1);
    assert.equal(await f.page.evaluate(() => window.reloadCount || 0), 0);
  } finally { await f.context.close(); }
});

test('an unfinished interview form survives data and deployment checks until cancelled', async () => {
  const f = await fixture();
  try {
    const callsBefore = f.state.calls.filter(call => call.path === '/api/jobs').length;
    await f.page.getByRole('button', { name: '+ Add interview date', exact: true }).click();
    const note = f.page.getByLabel('Round, interviewer, or notes (optional)');
    await note.fill('Unfinished notes to keep');
    await note.blur();
    f.state.version = 'build-b';
    f.state.jobs[0].title = 'Changed elsewhere';
    await f.advance(40_000);
    assert.equal(await note.inputValue(), 'Unfinished notes to keep');
    assert.equal(await f.page.evaluate(() => window.reloadCount || 0), 0);
    assert.equal(f.state.calls.filter(call => call.path === '/api/jobs').length, callsBefore);
    await f.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await f.advance();
    assert.equal(await f.page.evaluate(() => window.reloadCount), 1);
    await f.advance();
    assert.equal(await f.page.evaluate(() => window.reloadCount), 1, 'reload is requested once');
  } finally { await f.context.close(); }
});

test('a plain unsaved note stays protected after blur, including while the tab is hidden', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => { const note = document.createElement('textarea'); note.id = 'draft'; document.body.append(note); });
    await f.page.locator('#draft').fill('Keep my draft');
    await f.page.locator('#draft').blur();
    f.state.version = 'build-b';
    await f.advance();
    assert.equal(await f.page.evaluate(() => window.reloadCount || 0), 0);
    await f.page.locator('#draft').fill('');
    await f.page.locator('#draft').blur();
    await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); });
    const visibleReads = () => f.state.calls.filter(call => ['/api/version', '/api/jobs'].includes(call.path)).length;
    const calls = visibleReads();
    await f.advance();
    assert.equal(visibleReads(), calls, 'hidden tabs do not fetch job data or deployment status');
    assert.equal(await f.page.evaluate(() => window.reloadCount || 0), 0);
    await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await f.page.waitForFunction(() => window.reloadCount === 1);
  } finally { await f.context.close(); }
});

test('a save in progress defers a deployed version until the response is complete', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => { void fetch('/api/fixture-save', { method: 'POST' }); });
    while (!f.state.writing) await new Promise(resolve => setTimeout(resolve, 5));
    f.state.version = 'build-b';
    await f.advance();
    assert.equal(await f.page.evaluate(() => window.reloadCount || 0), 0);
    f.state.writing();
    await f.page.waitForResponse(response => response.url().endsWith('/api/fixture-save'));
    await f.advance(2_000);
    assert.equal(await f.page.evaluate(() => window.reloadCount), 1);
  } finally { await f.context.close(); }
});

test('an in-flight background response cannot overwrite a newer edit', async () => {
  const f = await fixture();
  try {
    f.state.hold = new Promise(resolve => { f.state.release = resolve; });
    f.state.jobs[0].title = 'Old background response';
    await f.page.clock.runFor(20_000);
    await f.page.waitForFunction(() => true);
    await f.page.getByRole('button', { name: '+ Add interview date', exact: true }).click();
    await f.page.getByLabel('Round, interviewer, or notes (optional)').fill('Newer draft');
    f.state.release();
    await f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs');
    assert.equal(await f.page.getByLabel('Round, interviewer, or notes (optional)').inputValue(), 'Newer draft');
    await f.page.getByRole('button', { name: 'Open Account Manager 0 at Example', exact: true }).waitFor();
  } finally { await f.context.close(); }
});

test('network failures retain current cards and recover on a later check', async () => {
  const f = await fixture();
  try {
    f.state.fail = true;
    await f.advance();
    await f.page.getByRole('button', { name: 'Open Account Manager 0 at Example', exact: true }).waitFor();
    f.state.fail = false;
    f.state.jobs[0].title = 'Recovered';
    await f.advance();
    await f.page.getByRole('button', { name: 'Open Recovered at Example', exact: true }).waitFor();
    assert.equal(await f.page.evaluate(() => window.reloadCount || 0), 0);
  } finally { await f.context.close(); }
});

test('company search also refreshes quietly with its loaded range', async () => {
  const f = await fixture({ tab: 'applied', company: true, count: 65 });
  try {
    await f.page.getByRole('button', { name: /^Load more/ }).click();
    await f.page.waitForFunction(() => document.querySelectorAll('.job-card').length === 65);
    f.state.jobs[60].title = 'Updated company result';
    await f.advance();
    await f.page.getByRole('button', { name: 'Open Updated company result at Example', exact: true }).waitFor();
    assert.equal(await f.page.locator('.job-card').count(), 65);
  } finally { await f.context.close(); }
});

for (const advanced of [false, true]) test(`${advanced ? 'advanced' : 'global'} search refreshes loaded pages without clearing the query`, async () => {
  const f = await fixture({ tab: 'applied', count: 65 });
  try {
    if (advanced) await f.page.getByRole('button', { name: 'Advanced Search', exact: true }).click();
    const input = advanced ? f.page.getByLabel('Search terms', { exact: true }) : f.page.getByPlaceholder('Search applied...');
    await input.fill('Account');
    if (advanced) await f.page.getByRole('button', { name: 'Search jobs', exact: true }).click();
    else { await input.blur(); await f.page.clock.runFor(400); }
    await f.page.getByRole('button', { name: /^Load more/ }).click();
    await f.page.waitForFunction(expected => document.querySelectorAll('.job-card').length === expected, advanced ? 65 : 60);
    f.state.jobs[advanced ? 60 : 55].title = 'Changed search result';
    await f.advance();
    await f.page.getByRole('button', { name: 'Open Changed search result at Example', exact: true }).waitFor();
    assert.equal(await input.inputValue(), 'Account');
    assert.equal(await f.page.locator('.job-card').count(), advanced ? 65 : 60);
  } finally { await f.context.close(); }
});

test('an open read-only card picks up changes but defers a version reload until closed', async () => {
  const f = await fixture();
  try {
    await f.page.getByRole('button', { name: 'Open Account Manager 0 at Example', exact: true }).click();
    await f.page.getByRole('dialog').waitFor();
    f.state.jobs[0].title = 'Updated open details';
    f.state.jobs[0].description = 'Updated description from the server';
    f.state.version = 'build-b';
    await f.advance();
    await f.page.getByRole('dialog').getByText('Updated open details', { exact: true }).waitFor();
    assert.equal(await f.page.evaluate(() => window.reloadCount || 0), 0);
    await f.page.getByRole('button', { name: 'Edit JD', exact: true }).click();
    assert.equal(await f.page.getByPlaceholder('Paste full job description here...').inputValue(), 'Updated description from the server');
    await f.page.getByRole('button', { name: 'Close job details', exact: true }).click();
    await f.advance();
    assert.equal(await f.page.evaluate(() => window.reloadCount), 1);
  } finally { await f.context.close(); }
});

test('programmatically cleared import fields resume automatic updates', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => { const input = document.createElement('input'); input.id = 'import-field'; document.body.append(input); });
    await f.page.locator('#import-field').fill('https://example.invalid/job');
    await f.page.locator('#import-field').blur();
    await f.advance();
    f.state.jobs[0].title = 'After saved import';
    await f.page.evaluate(() => { document.getElementById('import-field').value = ''; });
    await f.advance();
    await f.page.getByRole('button', { name: 'Open After saved import at Example', exact: true }).waitFor();
  } finally { await f.context.close(); }
});
