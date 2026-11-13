// Real merge dialog with fixture-only APIs; no saved cards are modified.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('merge review shows saved rejection reasons and missing-reason fallback without changing cards', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const job = { id: 'inbox', title: 'National Distribution Manager', company: 'Employer',
    status: 'inbox', location: 'Minneapolis, MN', source: 'JSearch', description: 'Manage distributor accounts.',
    scoreAuthorityState: 'current', aimFitScore: 84, reqFitScore: 85 };
  let rejected = { ...job, id: 'rejected', status: 'archived', source: 'ATS-workday',
    passReason: 'Locally triaged out: No target sales, account management, partnerships, or customer success title signal; score capped below triage.' };
  const score = value => ({ value, mode: 'preserved', sources: [] });
  const plan = card => ({ survivorId: card.id, redundantId: card.id === job.id ? rejected.id : job.id,
    survivorStatus: card.status, survivorReason: 'Keep the selected card and its status.', blockedReason: null,
    aim: score(84), experience: score(85) });
  const bundle = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ExpandOverlay} from './src/components/ExpandOverlay';
    createRoot(document.getElementById('root')).render(<ExpandOverlay job={${JSON.stringify(job)}}
      onClose={()=>{}} onCompanySelect={()=>{}} onStatusChange={()=>{throw Error('Unexpected card change')}}/>);`,
    resolveDir: root, loader: 'tsx' }, bundle: true, write: false, platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'fixture', setup(builder) {
      builder.onResolve({ filter: /\/atsUtils$/ }, () => ({ path: 'ats', namespace: 'fixture' }));
      builder.onResolve({ filter: /\/modal$/ }, () => ({ path: 'modal', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'ats'
        ? 'export const ATS_OPTIONS=["Workday"];export const identifyAts=()=>"Workday";'
        : 'export const showOptions=async()=>"link_only";export const showAlert=async()=>{};export const showConfirm=async()=>false;' }));
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; const mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (route.request().method() !== 'GET') {
        mutations.push(url.pathname);
        assert.equal(url.pathname, '/api/jobs/inbox/scrape', 'reviewing or selecting a card cannot merge it');
        return route.fulfill({ status: 409, json: { code: 'url_duplicate_conflict', mergeTargetJobId: rejected.id } });
      }
      if (url.pathname === '/api/jobs/inbox') return route.fulfill({ json: { job } });
      if (url.pathname === '/api/jobs/inbox/merge') return route.fulfill({ json: {
        cards: [{ ...job, passReason: null }, rejected], plan: plan(job),
        selectionPlans: { inbox: plan(job), rejected: plan(rejected) },
      } });
      return route.fulfill({ json: { copies: [], repeats: [] } });
    });
    const openReview = async () => {
      await page.goto(origin);
      await page.getByPlaceholder('Paste Direct URL...').fill('https://employer.example/jobs/1');
      await page.getByRole('button', { name: 'Scrape', exact: true }).click();
      await page.getByRole('heading', { name: 'Review these two cards' }).waitFor();
    };
    await openReview();
    const reason = page.locator('.duplicate-merge-rejection');
    assert.equal(await reason.count(), 1, 'active cards do not receive a rejection label');
    assert.equal(await reason.locator('p').innerText(), rejected.passReason);
    await page.screenshot({ path: '/tmp/career-merge-rejection-desktop.png', fullPage: true });
    await page.getByRole('radio', { name: /keep archived status/ }).check();
    assert.equal(await reason.locator('p').innerText(), rejected.passReason, 'choosing a survivor preserves its displayed reason');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    rejected = { ...rejected, status: 'dismissed', passReason: null };
    await openReview();
    assert.equal(await reason.locator('p').innerText(), 'No reason was recorded.');
    rejected = { ...rejected, status: 'passed', passReason: '<script>window.reasonExecuted=true</script> ' + 'VeryLongSavedLocation'.repeat(25) };
    await page.setViewportSize({ width: 390, height: 844 });
    await openReview();
    assert.equal(await reason.locator('p').innerText(), rejected.passReason);
    assert.equal(await page.evaluate(() => window.reasonExecuted), undefined, 'saved reasons render as text');
    const size = await reason.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(size.scroll <= size.width + 1, 'long reasons wrap on mobile');
    await reason.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/career-merge-rejection-mobile.png', fullPage: true });
    assert.deepEqual(mutations, Array(3).fill('/api/jobs/inbox/scrape'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
