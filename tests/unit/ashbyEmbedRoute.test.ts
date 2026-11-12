import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';

const require = createRequire(import.meta.url);
const id = '2aff777b-b582-4f46-ab33-28f4b8311928';
const board = 'https://jobs.ashbyhq.com/zafran-security';
const url = 'https://www.zafran.io/careers';
const description = 'Responsibilities: Activate existing channel partners, lead account planning and deliver enablement. Qualifications: Five years of channel management experience. '.repeat(8).trim();
const page = `<title>Zafran Careers</title><nav>Company AboutPartnersCustomer ReviewsCareers</nav>
  <h1>Come build with us</h1><div id="ashby_embed" data-ashby-board="${board}"></div>
  <p>${description}</p>`;

function replace(t: TestContext, target: object, key: string, implementation: unknown) {
  const prior = Reflect.get(target, key);
  assert.equal(Reflect.set(target, key, implementation), true);
  t.after(() => { Reflect.set(target, key, prior); });
}

function mockPages(t: TestContext, available = true) {
  const requests: string[] = [];
  t.mock.method(require('node:dns/promises'), 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(require('node:https'), 'request', (options: { servername: string; path: string }, callback: (body: Readable) => void) => {
    requests.push(`https://${options.servername}${options.path}`);
    let payload = page;
    if (options.servername === 'api.ashbyhq.com') {
      assert.equal(options.path, '/posting-api/job-board/zafran-security');
      payload = JSON.stringify({ jobs: available ? [{ id, title: 'Channel Account Manager (East)',
        descriptionPlain: description, location: 'USA', isRemote: true, jobUrl: `${board}/${id}` }] : [] });
    } else if (options.servername === 'jobs.ashbyhq.com') {
      assert.equal(options.path, `/zafran-security/${id}`);
      payload = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
        url: `${board}/${id}`, title: 'Channel Account Manager (East)', description,
        hiringOrganization: { name: 'Zafran' } })}</script>`;
    } else assert.equal(options.servername, 'www.zafran.io');
    return Object.assign(new EventEmitter(), { end() {
      queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(payload)]),
        { statusCode: 200, headers: {}, rawHeaders: ['Content-Type', 'text/html'] })));
    } });
  });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No generic page-reader fallback is permitted'));
  return requests;
}

for (const scenario of ['board', 'board-rescore', 'selected', 'unavailable'] as const) {
  test(`Ashby URL refresh: ${scenario} preserves canonical URL and existing work`, async t => {
    const { POST } = await import('../../src/app/api/jobs/[id]/scrape/route');
    const { prisma } = await import('../../src/lib/prisma');
    const selected = scenario === 'selected';
    const requests = mockPages(t, scenario !== 'unavailable');
    const submitted = `${url}${selected || scenario === 'unavailable' ? `?ashby_jid=${id}&ref=joe` : ''}#positions`;
    const old: Record<string, unknown> = { id: 'saved-zafran', title: 'Channel Partner Manager', company: 'Zafran',
      employer: 'Zafran', description: 'Existing scored job description', url: 'https://example.com/old-job',
      location: 'St Paul, Minnesota', manualAts: 'Unknown', status: 'applied', source: 'JSearch',
      updatedAt: new Date(), observations: [], scoringStatus: 'scored', experienceStatus: 'scored',
      fitScore: 72, aimFitScore: 67, reqFitScore: 84, tailoringStaged: true,
      jdBatchId: selected ? null : 'existing-jd-work', afBatchId: selected ? null : 'existing-score-work' };
    let saved = { ...old };
    const writes: Record<string, unknown>[] = [];
    replace(t, prisma.job, 'findMany', async () => []);
    replace(t, prisma.job, 'findUnique', async () => ({ ...saved }));
    for (const method of ['update', 'updateMany']) replace(t, prisma.job, method, async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data); saved = { ...saved, ...data };
      return method === 'update' ? { ...saved } : { count: 1 };
    });
    replace(t, prisma, '$transaction', async (run: (client: unknown) => Promise<unknown>) => run(prisma));
    replace(t, prisma, '$executeRaw', async () => 0);
    replace(t, prisma, '$queryRaw', async () => [{ id: 'existing-score', jobId: old.id,
      evaluationType: 'standard', family: 'legacy', schemaVersion: 'career-dashboard-fit-result-v1',
      aimFitScore: 67, experienceFitScore: 84, passed: true, staleAt: null, staleReason: null, createdAt: new Date() }]);
    replace(t, prisma.atsCompany, 'findMany', async () => [{ slug: 'zafran-security', platform: 'ashby', status: 'active' }]);
    replace(t, prisma.atsCompany, 'update', async () => ({}));
    const response = await POST(new Request('http://localhost/api/jobs/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: submitted, linkOnly: scenario !== 'board-rescore', skipRescore: scenario !== 'board-rescore' }),
    }), { params: Promise.resolve({ id: String(old.id) }) });
    const result = await response.json();
    assert.equal(response.status, scenario === 'board-rescore' ? 422 : 200, JSON.stringify(result));
    assert.equal(result.job.manualAts, 'Ashby');
    for (const key of ['url', 'canonicalUrl', 'userCanonicalUrl']) assert.equal(result.job[key], submitted);
    assert.equal(result.rescoreQueued, false);
    assert.equal(result.scoreInvalidated, false);
    for (const key of ['status', 'tailoringStaged', 'scoringStatus', 'experienceStatus', 'fitScore', 'aimFitScore', 'reqFitScore']) {
      assert.equal(result.job[key], old[key], key);
      assert.ok(writes.every(write => !(key in write)), `must not write ${key}`);
    }
    if (selected) {
      assert.equal(result.job.title, 'Channel Account Manager (East)');
      assert.equal(result.job.company, 'Zafran');
      assert.equal(result.job.location, 'USA (Remote)');
      assert.equal(result.job.description, description);
      assert.equal(result.refreshWarning, undefined);
      assert.equal(requests.filter(value => value.includes('api.ashbyhq.com')).length, 1);
    } else {
      assert.match(result.refreshWarning || result.error, /Ashby/);
      for (const key of ['title', 'company', 'employer', 'description', 'location']) {
        assert.equal(result.job[key], old[key], key);
        assert.ok(writes.every(write => !(key in write)), `unverified opening must not write ${key}`);
      }
      // The existing URL reconciliation cancels old workers for the previous
      // link. An unverified opening must not claim a new scrape or score lease.
      for (const key of ['jdBatchId', 'afBatchId', 'batchJobId']) {
        assert.ok(writes.every(write => write[key] === undefined || write[key] === null));
      }
      if (scenario !== 'unavailable') assert.ok(requests.every(value => !value.includes('api.ashbyhq.com')));
    }
  });
}

test('importing an embedded board requires an opening before any write or reader fallback', async t => {
  const { POST } = await import('../../src/app/api/jobs/manual-import/route');
  const { prisma } = await import('../../src/lib/prisma');
  mockPages(t);
  replace(t, prisma.job, 'findMany', async () => []);
  for (const method of ['create', 'update', 'updateMany']) replace(t, prisma.job, method, async () => assert.fail('No card mutation allowed'));
  const response = await POST(new Request('http://localhost/api/jobs/manual-import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  }));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /does not select an opening.*No job was imported/);
});

for (const linkOnly of [true, false]) {
  test(`Ashby refresh offers duplicate review for a saved employer link (linkOnly=${linkOnly})`, async t => {
    const { POST } = await import('../../src/app/api/jobs/[id]/scrape/route');
    const { prisma } = await import('../../src/lib/prisma');
    const { urlPostingIdentity } = await import('../../src/lib/jobUrlReconciliation');
    mockPages(t);
    const submitted = `${url}?ashby_jid=${id}&ref=joe`;
    const current = { id: 'current', title: 'Channel Account Manager (East)', company: 'Zafran',
      location: 'USA (Remote)', url: 'https://example.com/old-job', updatedAt: new Date(), observations: [] };
    const existing = { ...current, id: 'existing', url: `${url}?ashby_jid=${id}`,
      canonicalUrl: `${url}?ashby_jid=${id}`, postingIdentity: urlPostingIdentity(`${board}/${id}`),
      status: 'applied', submittedResume: 'submitted.docx', aimFitScore: 67, reqFitScore: 84 };
    replace(t, prisma.job, 'findMany', async () => [existing]);
    replace(t, prisma.job, 'findUnique', async ({ where }: { where: { id: string } }) =>
      where.id === current.id ? { ...current } : { ...existing });
    for (const method of ['create', 'update', 'updateMany']) {
      replace(t, prisma.job, method, async () => assert.fail('Duplicate detection must not mutate either card'));
    }
    replace(t, prisma, '$transaction', async (run: (client: unknown) => Promise<unknown>) => run(prisma));
    replace(t, prisma, '$executeRaw', async () => 0);
    replace(t, prisma, '$queryRaw', async () => []);
    const response = await POST(new Request('http://localhost/api/jobs/current/scrape', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: submitted, linkOnly, skipRescore: linkOnly }),
    }), { params: Promise.resolve({ id: current.id }) });
    const result = await response.json();
    assert.equal(response.status, 409);
    assert.equal(result.code, 'url_duplicate_conflict');
    assert.equal(result.mergeTargetJobId, existing.id);
    assert.match(result.error, /Review the two cards/);
  });
}
