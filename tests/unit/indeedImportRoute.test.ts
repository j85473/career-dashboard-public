import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';
const require = createRequire(import.meta.url);
function replace(t: TestContext, target: object, key: string, implementation: unknown) {
  const prior = Reflect.get(target, key);
  Reflect.set(target, key, implementation);
  t.after(() => { Reflect.set(target, key, prior); });
}
const key = '27d68cc76167ad0a';
const url = `https://www.indeed.com/viewjob?jk=${key}&advn=4274197825445369&from=rjp_mob.postApplyAd`;
const description = 'Responsibilities: Manage an assigned sales territory, develop account plans and build customer relationships. Qualifications: Three years of field sales experience and strong communication and organization skills. '.repeat(6);
const request = (body: object) => new Request('http://localhost/api/jobs/manual-import', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function setup(t: TestContext) {
  const { POST } = await import('../../src/app/api/jobs/manual-import/route');
  const { prisma } = await import('../../src/lib/prisma');
  replace(t, require('node:dns/promises'), 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  replace(t, prisma.job, 'findMany', async () => []);
  replace(t, prisma.job, 'findFirst', async () => null);
  replace(t, prisma.companyNameRule, 'findMany', async () => []);
  // Local processing is already covered separately; prevent background DB work.
  replace(t, prisma.job, 'updateMany', async () => ({ count: 0 }));
  return { POST, prisma };
}

test('a blocked Indeed link offers the paste fallback before creating a card or touching existing scores', async t => {
  const { POST, prisma } = await setup(t);
  replace(t, require('node:https'), 'request', () => { const error = new Error('Blocked by Indeed'); error.name = 'AbortError'; throw error; });
  replace(t, prisma.apiKeyCooldown, 'findMany', async () => []);
  const beforeKeys = process.env.RAPIDAPI_KEYS;
  const beforeNumbered = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^RAPIDAPI_KEY(?:_\d+)?$/.test(name)));
  process.env.RAPIDAPI_KEYS = ' ';
  for (const name of Object.keys(beforeNumbered)) delete process.env[name];
  t.after(() => { if (beforeKeys === undefined) delete process.env.RAPIDAPI_KEYS; else process.env.RAPIDAPI_KEYS = beforeKeys; Object.assign(process.env, beforeNumbered); });
  for (const method of ['create', 'update', 'updateMany', 'delete']) replace(t, prisma.job, method, async () => assert.fail('No writes allowed for an unreadable posting'));
  replace(t, prisma, '$transaction', async () => assert.fail('No score or lifecycle writes allowed'));
  const response = await POST(request({ url }));
  const result = await response.json();
  assert.equal(response.status, 422, JSON.stringify(result));
  assert.equal(result.needManual, true);
  assert.equal(result.job, undefined);
});

test('Indeed Easy Apply imports use exact posting metadata and retain the original apply link', async t => {
  const { POST, prisma } = await setup(t);
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Territory Sales Representative',
    hiringOrganization: { name: 'Example Employer' }, description, url: `https://www.indeed.com/viewjob?jk=${key}` })}</script>`;
  replace(t, require('node:https'), 'request', (options: { servername: string; path: string }, callback: (body: Readable) => void) => {
    assert.equal(options.servername, 'www.indeed.com');
    assert.equal(options.path, `/viewjob?jk=${key}`);
    const req = new EventEmitter();
    return Object.assign(req, { end() { queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(html)]),
      { statusCode: 200, statusMessage: 'OK', headers: {}, rawHeaders: ['Content-Type', 'text/html'] }))); } });
  });
  let created: Record<string, unknown> | null = null;
  replace(t, prisma.job, 'create', async ({ data }: { data: Record<string, unknown> }) => { created = { id: 'new-indeed', ...data }; return created; });
  replace(t, prisma.job, 'findUnique', async () => created);
  const response = await POST(request({ url }));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.job.title, 'Territory Sales Representative');
  assert.equal(result.job.company, 'Example Employer');
  assert.equal(result.job.description, description.trim());
  assert.equal(result.job.source, 'Manual Import');
  assert.equal(result.job.url, url);
  assert.equal(result.job.userCanonicalUrl, url);
  assert.equal(result.job.status, 'inbox');
  assert.equal(result.job.tailoringStaged, true);
  assert.equal(result.job.scoringStatus, 'queued');
  assert.ok(result.job.postingIdentity);
  assert.equal(result.refreshWarning, undefined);
});

test('pasted Indeed details import without requesting the blocked page again; incomplete details create no card', async t => {
  const { POST, prisma } = await setup(t);
  replace(t, require('node:https'), 'request', () => assert.fail('Pasted details must not fetch the blocked page'));
  let created: Record<string, unknown> | null = null;
  replace(t, prisma.job, 'create', async ({ data }: { data: Record<string, unknown> }) => { created = { id: 'pasted-indeed', ...data }; return created; });
  replace(t, prisma.job, 'findUnique', async () => created);
  const details = { url, title: 'Territory Sales Representative', company: 'Example Employer', location: 'Minneapolis, MN', description };
  for (const invalid of [{ ...details, description: 'short snippet' }, { ...details, title: 'Viewjob' }, { ...details, company: 'Indeed' }]) {
    const response = await POST(request(invalid));
    assert.equal(response.status, 422);
    assert.equal(created, null);
  }
  const response = await POST(request(details));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.job.title, details.title);
  assert.equal(result.job.location, details.location);
  assert.equal(result.job.description, description.trim());
  assert.equal(result.job.url, url);
});

test('an Indeed search page without a selected opening is rejected without database writes', async t => {
  const { POST, prisma } = await setup(t);
  replace(t, prisma.job, 'findMany', async () => assert.fail('No selected opening'));
  const response = await POST(request({ url: 'https://www.indeed.com/jobs?q=sales' }));
  assert.equal(response.status, 422);
});

test('a different tracked Indeed link reopens the saved card with its scores and lifecycle intact', async t => {
  const { POST, prisma } = await setup(t);
  const existing = { id: 'existing-indeed', title: 'Territory Sales Representative', company: 'Example Employer',
    url, canonicalUrl: url, source: 'Manual Import', status: 'applied', scoringStatus: 'scored',
    fitScore: 55, aimFitScore: 87, reqFitScore: 89, tailoringStaged: false, passReason: null, updatedAt: new Date() };
  // Only the legacy key lookup finds the saved advertising URL.
  replace(t, prisma.job, 'findMany', async (query: { where: { OR: Array<{ url?: unknown }> } }) =>
    query.where.OR.some(condition => typeof condition.url === 'object') ? [existing] : []);
  replace(t, prisma.job, 'findUnique', async () => existing);
  replace(t, prisma.jobStatusHistory, 'findFirst', async () => null);
  replace(t, prisma.job, 'updateMany', async ({ data }: { data: Record<string, unknown> }) => {
    assert.deepEqual(Object.keys(data).sort(), ['canonicalUrl', 'url', 'userCanonicalUrl', 'userCanonicalUrlUpdatedAt']); return { count: 0 };
  });
  for (const method of ['create', 'update', 'delete']) replace(t, prisma.job, method, async () => assert.fail('Must reopen existing work'));
  const response = await POST(request({ url: `https://www.indeed.com/jobs?q=sales&vjk=${key}` }));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.isDuplicate, true);
  assert.equal(result.job.id, existing.id);
  assert.equal(result.job.status, 'applied');
  assert.equal(result.job.aimFitScore, 87);
  assert.equal(result.job.reqFitScore, 89);
  assert.equal(result.job.tailoringStaged, false);
});
