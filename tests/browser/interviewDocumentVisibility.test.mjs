import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('interview attachment options appear at Interviewing and remain with all documents after returning to Applied', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const job = { id: 'job', title: 'Account Manager', company: 'Employer', status: 'applied', hasInterviewHistory: false,
    attachments: [] };
  const bundle = await build({ stdin: { contents: `
    import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
    import {JobDocuments} from './src/components/JobDocuments';
    function App(){const [job,setJob]=useState(null);useEffect(()=>{fetch('/fixture').then(r=>r.json()).then(setJob)},[]);
      return job&&<main><h1>{job.status}</h1><JobDocuments job={job}/></main>}
    createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'preview', setup(builder) {
      builder.onResolve({ filter: /\/JobDocumentPreview$/ }, () => ({ path: 'preview', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function JobDocumentPreview(){return null}' }));
    } }],
  });
  const server = createServer((req, res) => {
    if (req.url === '/fixture') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(job)); }
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].contents); }
    if (req.url.startsWith('/api/jobs/job/attachments/')) { res.setHeader('Content-Type', 'text/plain'); return res.end('Saved document bytes'); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('heading', { name: 'applied' }).waitFor();
    assert.equal(await page.locator('.job-documents').count(), 0);
    job.status = 'interviewing'; job.hasInterviewHistory = true;
    job.attachments = ['jd', 'prep', 'transcript'].map(kind => ({ id: kind, kind, fileName: `${kind}.txt`,
      mimeType: 'text/plain', sizeBytes: 20, uploadedAt: '2026-11-13T18:00:00Z' }));
    const originalAttachments = structuredClone(job.attachments);
    await page.reload();
    await page.getByRole('button', { name: 'Attach prep pack', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Attach / }).count(), 3);
    job.status = 'applied';
    await page.reload();
    await page.getByRole('heading', { name: 'applied' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Attach / }).count(), 3);
    for (const kind of ['jd', 'prep', 'transcript']) {
      await page.locator(`a.job-attachment-link[href*="/attachments/${kind}"]`).waitFor();
      assert.equal(await (await page.request.get(`${origin}/api/jobs/job/attachments/${kind}`)).text(), 'Saved document bytes');
    }
    assert.deepEqual(job.attachments, originalAttachments);
    job.attachments = [];
    await page.reload();
    await page.getByRole('heading', { name: 'applied' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Attach / }).count(), 3, 'interview history remains after documents are removed');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
