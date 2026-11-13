import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { appliedIdentityFingerprint } from '../appliedDuplicateIdentity';

test('ATS-only PATCH updates preserve all saved scores, rationale, decisions, and scoring state', async (t) => {
  let saved: Record<string, unknown>;
  let scoringCalls = 0;
  const writes: Record<string, unknown>[] = [];
  const store = {
    job: {
      findUnique: async () => ({ ...saved }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data); saved = { ...saved, ...data }; return { ...saved };
      },
    },
    $queryRaw: async () => [{ status: saved.status, tailoringStaged: saved.tailoringStaged, updatedAt: saved.updatedAt }],
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(store),
  };
  const globals = globalThis as typeof globalThis & { __atsPatchFixture?: unknown };
  globals.__atsPatchFixture = { store, score: () => { scoringCalls++; } };
  t.after(() => { delete globals.__atsPatchFixture; });
  const actualScoreAuthority = JSON.stringify(path.resolve('src/lib/scoreAuthority.ts'));
  const stubs: Record<string, string> = {
    '@/lib/jobScoring': 'export function recomputeLocalScore(){globalThis.__atsPatchFixture.score();}',
    '@/lib/jobLifecycleInvariant': 'export async function assertJobLifecycleInvariants(){}',
    '@/lib/appliedDuplicateStore': 'export async function suppressLiveAppliedDuplicates(){return []}',
    '@/lib/jobScoreAuthorityQuery': 'export async function latestJobScoreEvents(){return new Map()}',
    '@/lib/jobApplicationContext': 'export async function withJobApplicationContext(jobs){return jobs}',
    '@/lib/scoreAuthority': `export * from ${actualScoreAuthority}; export const projectJobScoreAuthority=job=>job;`,
  };
  const bundle = await build({
    entryPoints: ['src/app/api/jobs/[id]/route.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'isolated-store', setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)prisma$/ }, () => ({ path: 'prisma', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@\/lib\// }, args => stubs[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
        contents: args.path === 'prisma' ? 'export const prisma=globalThis.__atsPatchFixture.store;' : stubs[args.path],
        resolveDir: process.cwd(),
      }));
    } }],
  });
  const compiledModule = { exports: {} as { PATCH: (request: Request, context: unknown) => Promise<Response> } };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
  for (const status of ['inbox', 'applied', 'archived', 'dismissed']) {
    for (const edit of [{ manualAts: 'Workday' }, { linkedinEasyApply: true }]) {
      saved = {
        id: 'preserved', title: 'Account Manager', company: 'Employer', employer: 'Employer', source: 'ATS-workday',
        location: 'Minneapolis, MN', description: 'Manage existing accounts.', url: 'https://example.com/job/1', canonicalUrl: null,
        status, passReason: status === 'archived' || status === 'dismissed' ? 'Location mismatch' : null,
        tailoringStaged: false, identityFingerprint: appliedIdentityFingerprint({ title: 'Account Manager', company: 'Employer', location: 'Minneapolis, MN' }),
        manualAts: 'Unknown', linkedinEasyApply: null,
        fitScore: 55, fitCategory: 'low-confidence', fitRationale: 'Original local assessment', recommendedResume: 'Saved resume',
        aimFitScore: 82, reqFitScore: 87, reqFitRationale: 'Original experience assessment', travelScore: 80,
        scoringStatus: 'scored', experienceStatus: 'scored', scoreAttempts: 2, scoreError: null,
        updatedAt: new Date('2026-11-13T18:00:00Z'),
      };
      const before = structuredClone(saved);
      writes.length = 0;
      const response = await compiledModule.exports.PATCH(new Request('http://localhost/api/jobs/preserved', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit),
      }), { params: Promise.resolve({ id: saved.id }) });
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const expectedEdit = status === 'applied' ? { ...edit, identityFingerprint: before.identityFingerprint } : edit;
      assert.deepEqual(writes, [expectedEdit]);
      assert.deepEqual(saved, { ...before, ...edit });
      assert.equal(scoringCalls, 0, 'an informational ATS edit cannot invoke scoring');
      const { job, rescoreQueued } = await response.json();
      assert.equal(job.fitScore, before.fitScore);
      assert.equal(job.aimFitScore, before.aimFitScore);
      assert.equal(job.reqFitScore, before.reqFitScore);
      assert.equal(job.status, status);
      assert.equal(rescoreQueued, false);
    }
  }
});
