import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Runs the actual component in a browser, with only its HTTP/clipboard boundaries stubbed.
test('failed tracking retains the card; copy reminders, history and generation errors remain visible', async () => {
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {LinkedInPostsTab} from './src/components/LinkedInPostsTab'; createRoot(document.getElementById('root')).render(<LinkedInPostsTab/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser' });
  const server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); }
    else { res.setHeader('content-type', 'text/html'); res.end('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.lastCopied = text; } } });
    });
    let draft = { id: 'test-id', title: 'One contact for orders', url: 'https://example.com/story', postText: 'A concrete post for browser validation.', copiedAt: null, trackedAt: null, status: 'draft', source: null };
    let failTracking = true, stalePosted = false;
    const workspace = () => ({ options: draft.status === 'draft' ? [draft] : [], history: draft.status === 'draft' ? [] : [draft], trackedArticles: [], remaining: draft.status === 'draft' ? 1 : 0 });
    const actions = [];
    await page.route('**/api/linkedin/**', async route => {
      const req = route.request();
      const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (req.url().endsWith('/generate')) {
        if (req.method() === 'POST') return json(502, { error: 'The writer is unavailable. Saved drafts are unchanged.' });
        return json(200, workspace());
      }
      const input = req.postDataJSON(); actions.push(input);
      if (failTracking) return json(500, { error: 'Could not save that action. Please try again.' });
      if (stalePosted) return json(409, { error: 'This draft is already posted. Reload to see your history.' });
      if (input.action === 'copy') { draft = { ...draft, copiedAt: new Date().toISOString() }; return json(200, { ...workspace(), copyText: draft.postText + '\n\n' + draft.url }); }
      draft = { ...draft, status: input.action, trackedAt: new Date().toISOString() }; return json(200, workspace());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Mark posted' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark posted' }).count(), 1);
    failTracking = false;
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.getByRole('button', { name: 'Copy again' }).waitFor();
    assert.equal(await page.evaluate(() => window.lastCopied), draft.postText + '\n\n' + draft.url);
    const count = actions.length;
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Copy again' }).click();
    assert.equal(actions.length, count);
    stalePosted = true;
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Copy again' }).click();
    await page.getByRole('alert').filter({ hasText: 'already posted' }).waitFor();
    stalePosted = false;
    await page.getByRole('button', { name: 'Mark posted' }).click();
    await page.getByText('No unused drafts are ready.', { exact: false }).waitFor();
    await page.reload();
    await page.getByText('No unused drafts are ready.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Copy', exact: true }).count(), 0);
    await page.getByText('Posting history and archived drafts (1)', { exact: true }).click();
    await page.getByText('Posted · One contact for orders', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Generate Post Options' }).click();
    await page.getByRole('alert').filter({ hasText: 'writer is unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Copy', exact: true }).count(), 0);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
