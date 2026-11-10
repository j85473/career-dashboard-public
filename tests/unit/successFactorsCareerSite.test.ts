import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { isSuccessFactorsCareerSite, parseSuccessFactorsCareerSitePosting } from '../../src/lib/successFactorsCareerSite';
import { parseJsonLdPostingHtml } from '../../src/lib/atsApi';

const url = 'https://careers.example.com/job/Shoreview-Account-Manager/1444273000/';
const description = '<h2>Responsibilities</h2><p>Manage partner accounts and coordinate customer programs. </p>'.repeat(10)
  + '<h2>Qualifications</h2><ul><li>Five years of account management experience.</li></ul>';
const config = `<script>j2w.init({ "ssoCompanyId": 'example', "ssoUrl": 'https://career4.successfactors.com' });</script>`;
const page = `${config}<link rel="canonical" href="${url}">
<div class="jobDisplayShell" itemscope itemtype="http://schema.org/JobPosting">
<meta itemprop="hiringOrganization" content="Actual Employer">
<span itemprop="title">Account Manager</span>
<span itemprop="address"><meta itemprop="addressLocality" content="Shoreview"><meta itemprop="addressRegion" content="MN"><meta itemprop="addressCountry" content="US"></span>
<span itemprop="address"><meta itemprop="addressLocality" content="Austin"><meta itemprop="addressRegion" content="TX"><meta itemprop="addressCountry" content="US"></span>
<span itemprop="description">${description}</span>
<a href="/talentcommunity/apply/1444273000/?locale=en_US">Apply</a></div>`;

test('employer-branded SAP pages identify the provider and return authored microdata without navigation', () => {
  const result = parseSuccessFactorsCareerSitePosting(page, url);
  assert.equal(result?.ats, 'SuccessFactors');
  assert.equal(result?.company, 'Actual Employer');
  assert.equal(result?.title, 'Account Manager');
  assert.equal(result?.location, 'Shoreview, MN, US; Austin, TX, US');
  assert.match(result!.text, /\n• Five years/);
  assert.doesNotMatch(result!.text, /Apply/);
  assert.equal(result?.platform, undefined, 'do not invent an acquisition board identity from a vanity URL');
});

test('a vendor mention, logo, lookalike host or isolated SSO URL does not identify the provider', () => {
  for (const html of [
    '<p>Experience with SuccessFactors required.</p>',
    '<img src="https://rmkcdn.successfactors.com/logo.png">',
    config.replace('career4.successfactors.com', 'career4.successfactors.com.evil.example'),
    config.replace('j2w.init', 'other.init'),
    config.replace('<script>', '<p>').replace('</script>', '</p>'),
  ]) assert.equal(isSuccessFactorsCareerSite(html), false);
});

test('microdata cannot replace a card using another posting, a listing, or incomplete evidence', () => {
  assert.equal(parseSuccessFactorsCareerSitePosting(page, url.replace('1444273000', '1444273001')), null);
  for (const html of [
    page.replace('/apply/1444273000/', '/apply/999/'),
    page.replace('rel="canonical"', 'rel="alternate"'),
    page.replace('itemtype="http://schema.org/JobPosting"', 'itemtype="http://schema.org/ItemList"'),
    page.replace(description, 'Loading...'),
    page.replace('content="Actual Employer"', 'content=""'),
  ]) assert.equal(parseSuccessFactorsCareerSitePosting(html, url), null);
});

test('SAP configuration also identifies employer-branded JSON-LD postings', () => {
  const html = `${config}<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
    url, title: 'Account Manager', description, hiringOrganization: { name: 'Actual Employer' } })}</script>`;
  assert.equal(parseJsonLdPostingHtml(html, url)?.ats, 'SuccessFactors');
});

test('a branded SAP link refresh saves the provider and keeps existing scores and lifecycle', async t => {
  const require = createRequire(import.meta.url);
  const { POST } = await import('../../src/app/api/jobs/[id]/scrape/route');
  const { prisma } = await import('../../src/lib/prisma');
  const savedId = 'saved-sap-card';
  let saved: Record<string, unknown> = { id: savedId, title: 'Account Manager', company: 'Actual Employer',
    description: 'Old scored description', url: 'https://www.linkedin.com/jobs/view/123', manualAts: 'Unknown',
    status: 'applied', source: 'LinkedIn (Apify)', updatedAt: new Date(), observations: [], scoringStatus: 'scored',
    fitScore: 72, aimFitScore: 67, reqFitScore: 84, jdBatchId: null };
  const writes: Record<string, unknown>[] = [];
  const replace = (target: object, key: string, implementation: unknown) => {
    const prior = Reflect.get(target, key);
    Reflect.set(target, key, implementation);
    t.after(() => { Reflect.set(target, key, prior); });
  };
  t.mock.method(require('node:dns/promises'), 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(require('node:https'), 'request', (options: { servername: string }, callback: (body: Readable) => void) => {
    assert.equal(options.servername, 'careers.example.com');
    return Object.assign(new EventEmitter(), { end() {
      queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(page)]),
        { statusCode: 200, headers: {}, rawHeaders: ['Content-Type', 'text/html'] })));
    } });
  });
  replace(prisma.job, 'findMany', async () => []);
  replace(prisma.job, 'findUnique', async () => ({ ...saved }));
  replace(prisma.job, 'update', async ({ data }: { data: Record<string, unknown> }) => {
    writes.push(data); saved = { ...saved, ...data }; return { ...saved };
  });
  replace(prisma.job, 'updateMany', async ({ data }: { data: Record<string, unknown> }) => {
    writes.push(data); saved = { ...saved, ...data }; return { count: 1 };
  });
  replace(prisma, '$transaction', async (run: (client: unknown) => Promise<unknown>) => run(prisma));
  replace(prisma, '$executeRaw', async () => 0);
  replace(prisma, '$queryRaw', async () => [{ id: 'existing-score', jobId: savedId,
    evaluationType: 'standard', family: 'legacy', schemaVersion: 'career-dashboard-fit-result-v1',
    aimFitScore: 67, experienceFitScore: 84, passed: true, staleAt: null, staleReason: null, createdAt: new Date() }]);
  const response = await POST(new Request('http://localhost/api/jobs/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, linkOnly: true, skipRescore: true }),
  }), { params: Promise.resolve({ id: savedId }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.job.manualAts, 'SuccessFactors');
  assert.equal(result.job.url, url);
  assert.equal(result.job.company, 'Actual Employer');
  assert.equal(result.job.fitScore, 72);
  assert.equal(result.job.aimFitScore, 67);
  assert.equal(result.job.reqFitScore, 84);
  assert.equal(result.job.status, 'applied');
  assert.equal(result.rescoreQueued, false);
  assert.equal(result.scoreInvalidated, false);
  assert.ok(writes.every(write => !('aimFitScore' in write) && !('reqFitScore' in write) && !('fitScore' in write)));
});
