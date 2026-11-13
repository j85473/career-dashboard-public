import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';

const require = createRequire(import.meta.url);
const url = 'https://www.appone.com/MainInfoReq.asp?R_ID=7193063';
const html = readFileSync(new URL('../fixtures/appone/area-sales-manager-minneapolis.html', import.meta.url), 'utf8');
const title = 'Area Sales Manager II - Minneapolis, MN';
function replace(t: TestContext, target: object, key: string, implementation: unknown) {
  const prior = Reflect.get(target, key);
  assert(Reflect.set(target, key, implementation));
  t.after(() => { Reflect.set(target, key, prior); });
}
function mockPage(t: TestContext, page = html, status = 200) {
  const requests: string[] = [];
  t.mock.method(require('node:dns/promises'), 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(require('node:https'), 'request', (options: { hostname: string; servername: string; path: string }, callback: (body: Readable) => void) => {
    assert.equal(options.hostname, '8.8.8.8');
    assert.equal(options.servername, 'www.appone.com');
    requests.push(options.path);
    return Object.assign(new EventEmitter(), { end() {
      queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(page)]),
        { statusCode: status, headers: {}, rawHeaders: ['Content-Type', 'text/html'] })));
    } });
  });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('AppOne must not use a model or whole-page reader'));
  return requests;
}
const request = (value: string, extra = {}) => new Request('http://localhost/api/jobs/manual-import', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: value, ...extra }),
});

test('AppOne metadata reads resolve application aliases through the verified description reader', async t => {
  const { scrapeJobPostingMetadata } = await import('../../src/lib/atsApi');
  const requests = mockPage(t);
  const metadata = await scrapeJobPostingMetadata(url.replace('MainInfoReq', 'Main') + '&PositionID=858992');
  assert.equal(metadata?.title, title);
  assert.equal(metadata?.company, 'Electrolit USA');
  assert.equal(metadata?.location, 'Minneapolis, MN');
  assert.equal(requests.length, 1);
  assert(requests[0].startsWith('/MainInfoReq.asp?'));
});

test('AppOne application import saves the exact posting with complete fields and no whole-page refresh', async t => {
  const { POST } = await import('../../src/app/api/jobs/manual-import/route');
  const { prisma } = await import('../../src/lib/prisma');
  const { urlPostingIdentity } = await import('../../src/lib/jobUrlReconciliation');
  const submitted = url.replace('MainInfoReq', 'Main') + '&PositionID=858992&Refer=board';
  const requests = mockPage(t);
  let created: Record<string, unknown> | null = null;
  replace(t, prisma.job, 'findMany', async () => []);
  replace(t, prisma.job, 'findFirst', async () => null);
  replace(t, prisma.job, 'create', async ({ data }: { data: Record<string, unknown> }) => {
    created = { id: 'new-appone', ...data }; return created;
  });
  replace(t, prisma.job, 'findUnique', async () => created);
  replace(t, prisma.companyNameRule, 'findMany', async () => []);
  replace(t, prisma.job, 'updateMany', async () => ({ count: 0 }));
  const response = await POST(request(submitted));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.job.title, title);
  assert.equal(result.job.company, 'Electrolit USA');
  assert.equal(result.job.location, 'Minneapolis, MN');
  assert.equal(result.job.manualAts, 'AppOne');
  assert.equal(result.job.url, submitted);
  assert.equal(result.job.userCanonicalUrl, submitted);
  assert.equal(result.job.postingIdentity, urlPostingIdentity(url));
  assert.equal(result.job.fingerprint, null, 'Different R_IDs must not collide on title/company/location');
  assert.equal(result.job.status, 'inbox');
  assert.equal(result.job.scoringStatus, 'queued');
  assert.match(result.job.description, /Minimum three \(3\) years/);
  assert.doesNotMatch(result.job.description, /WE ALSO RECOMMEND|technical assistance|cookies/i);
  assert.equal(result.refreshWarning, undefined);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^\/MainInfoReq\.asp\?/);
});

test('AppOne missing selection, wrong requisition and failed reads reject imports before any card write', async t => {
  const { POST } = await import('../../src/app/api/jobs/manual-import/route');
  const { prisma } = await import('../../src/lib/prisma');
  mockPage(t, html.replace("name='R_ID' value='7193063'", "name='R_ID' value='9999999'"));
  replace(t, prisma.job, 'findMany', async () => []);
  for (const method of ['create', 'update', 'updateMany', 'delete']) {
    replace(t, prisma.job, method, async () => assert.fail('Unverified AppOne content cannot change cards'));
  }
  for (const value of ['https://www.appone.com', url, url + '&R_ID=9999999']) {
    const response = await POST(request(value));
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /AppOne.*No job was imported/);
  }
});

test('reimport finds a legacy AppOne card through R_ID and repairs metadata while preserving scored work', async t => {
  const { POST } = await import('../../src/app/api/jobs/manual-import/route');
  const { prisma } = await import('../../src/lib/prisma');
  mockPage(t);
  const prior: Record<string, unknown> = { id: 'legacy-appone', title: `Job Information: ${title} Job`, company: 'Unknown Company',
    location: null, url, canonicalUrl: url, source: 'Manual Import', status: 'applied', passReason: null, tailoringStaged: true,
    description: 'Previously scored description', updatedAt: new Date(), scoringStatus: 'scored', experienceStatus: 'scored',
    fitScore: 85, aimFitScore: 82, reqFitScore: 78, jdBatchId: null, afBatchId: null, batchJobId: null };
  let saved = { ...prior };
  const writes: Record<string, unknown>[] = [];
  replace(t, prisma.job, 'findMany', async (query: { where: unknown }) =>
    JSON.stringify(query.where).includes('"contains":"R_ID=7193063"') ? [saved] : []);
  replace(t, prisma.job, 'findUnique', async () => ({ ...saved }));
  replace(t, prisma.job, 'updateMany', async ({ data }: { data: Record<string, unknown> }) => {
    writes.push(data); saved = { ...saved, ...data }; return { count: 1 };
  });
  replace(t, prisma.job, 'create', async () => assert.fail('Same R_ID must reuse the existing card'));
  replace(t, prisma.scoringBatchItem, 'count', async () => 0);
  replace(t, prisma.companyNameRule, 'findMany', async () => []);
  replace(t, prisma.jobStatusHistory, 'findFirst', async () => null);
  replace(t, prisma.jobPipelineEvent, 'upsert', async () => ({}));
  replace(t, prisma, '$transaction', async (run: (client: unknown) => Promise<unknown>) => run(prisma));
  const submitted = url.replace('MainInfoReq', 'Main') + '&Refer=board';
  const response = await POST(request(submitted));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.isDuplicate, true);
  assert.equal(result.job.id, prior.id);
  assert.equal(result.job.title, title);
  assert.equal(result.job.company, 'Electrolit USA');
  assert.equal(result.job.location, 'Minneapolis, MN');
  for (const key of ['status', 'description', 'tailoringStaged', 'scoringStatus', 'experienceStatus', 'fitScore', 'aimFitScore', 'reqFitScore']) {
    assert.equal(result.job[key], prior[key], key);
    assert(writes.every(write => !(key in write)), `Metadata repair must not write ${key}`);
  }
});

test('AppOne refresh replaces the cluttered description and preserves scores when requested', async t => {
  const { POST } = await import('../../src/app/api/jobs/[id]/scrape/route');
  const { prisma } = await import('../../src/lib/prisma');
  const requests = mockPage(t);
  const prior: Record<string, unknown> = { id: 'legacy-appone', title: `Job Information: ${title} Job`, company: 'Unknown Company',
    employer: 'Unknown Company', location: null, url, canonicalUrl: url, source: 'Manual Import', manualAts: 'Unknown',
    status: 'applied', passReason: null, tailoringStaged: true, observations: [], description: 'Old cluttered page',
    updatedAt: new Date(), scoringStatus: 'scored', experienceStatus: 'scored', fitScore: 85, aimFitScore: 82, reqFitScore: 78 };
  let saved = { ...prior };
  const writes: Record<string, unknown>[] = [];
  replace(t, prisma.job, 'findMany', async () => []);
  replace(t, prisma.job, 'findUnique', async () => ({ ...saved }));
  for (const method of ['update', 'updateMany']) replace(t, prisma.job, method, async ({ data }: { data: Record<string, unknown> }) => {
    writes.push(data); saved = { ...saved, ...data };
    return method === 'update' ? { ...saved } : { count: 1 };
  });
  replace(t, prisma.companyNameRule, 'findMany', async () => []);
  replace(t, prisma.jobPipelineEvent, 'upsert', async () => ({}));
  replace(t, prisma, '$transaction', async (run: (client: unknown) => Promise<unknown>) => run(prisma));
  replace(t, prisma, '$executeRaw', async () => 0);
  replace(t, prisma, '$queryRaw', async () => [{ id: 'saved-score', jobId: prior.id, evaluationType: 'standard', family: 'legacy',
    schemaVersion: 'career-dashboard-fit-result-v1', aimFitScore: 82, experienceFitScore: 78, passed: true,
    staleAt: null, staleReason: null, createdAt: new Date() }]);
  const response = await POST(request(url, { skipRescore: true }), { params: Promise.resolve({ id: String(prior.id) }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.job.title, title);
  assert.equal(result.job.company, 'Electrolit USA');
  assert.equal(result.job.location, 'Minneapolis, MN');
  assert.equal(result.job.manualAts, 'AppOne');
  assert.match(result.job.description, /Minimum three \(3\) years/);
  assert.doesNotMatch(result.job.description, /WE ALSO RECOMMEND|technical assistance|cookies/i);
  assert.equal(result.rescoreQueued, false);
  assert.equal(result.scoreInvalidated, false);
  for (const key of ['status', 'tailoringStaged', 'scoringStatus', 'experienceStatus', 'fitScore', 'aimFitScore', 'reqFitScore']) {
    assert.equal(result.job[key], prior[key], key);
    assert(writes.every(write => !(key in write)), `Refresh must preserve ${key}`);
  }
  assert(requests.every(path => path.startsWith('/MainInfoReq.asp?')));
});
