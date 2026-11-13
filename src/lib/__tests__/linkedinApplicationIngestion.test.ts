import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '../prismaClient';

test('LinkedIn rediscovery stores explicit application metadata without changing scores, links, or lifecycle', async () => {
  const job = { id: 'saved-job', source: 'LinkedIn (Apify)', status: 'archived',
    url: 'https://www.linkedin.com/jobs/view/123', canonicalUrl: 'https://www.linkedin.com/jobs/view/123',
    aimFitScore: 72, reqFitScore: 88, manualAts: 'Workday', linkedinEasyApply: null as boolean | null };
  const original = structuredClone(job);
  const writes: unknown[] = [];
  const empty = async () => [];
  const store = {
    companyNameRule: { findMany: empty },
    providerCircuit: { findMany: empty },
    jobSourceObservation: { findUnique: async () => ({ id: 'observation', sourceId: '123', jobId: job.id, url: job.url, job }) },
    job: { findUnique: async () => null, updateMany: async (args: { data: { linkedinEasyApply: boolean } }) => {
      writes.push(args);
      job.linkedinEasyApply = args.data.linkedinEasyApply;
      return { count: 1 };
    } },
    jobPipelineEvent: { upsert: async () => ({}) },
    ingestionSourceRun: { create: async () => ({ id: 'run' }), update: async () => ({}) },
    $transaction: async (run: (tx: unknown) => unknown) => run(store),
  };
  (globalThis as unknown as { prisma: PrismaClient }).prisma = store as unknown as PrismaClient;
  const { ingestExternalJob, ingestJobs } = await import('../jobIngestion');
  const input = { source: job.source, sourceId: '123', title: 'Account Manager', company: 'Acme',
    url: job.url, location: 'Minneapolis, MN', description: 'Manage customer accounts.', linkedinEasyApply: true };
  assert.equal(await ingestExternalJob(input), 'duplicate');
  assert.deepEqual(writes.pop(), { where: { id: job.id, source: { startsWith: 'LinkedIn', mode: 'insensitive' } },
    data: { linkedinEasyApply: true } });
  assert.deepEqual(job, { ...original, linkedinEasyApply: true });
  await ingestExternalJob({ ...input, linkedinEasyApply: null });
  assert.equal(writes.length, 0, 'an unknown flag must not erase known evidence');
  assert.equal(job.linkedinEasyApply, true);
  await ingestJobs(undefined, undefined, undefined, undefined, 'pending_af', true, {
    useStandard: false, usePaidApis: false, useCareerforce: false,
    prefetchedAggregatorCandidates: [{ ...input, linkedinEasyApply: false }],
  });
  assert.deepEqual(writes.pop(), { where: { id: job.id, source: { startsWith: 'LinkedIn', mode: 'insensitive' } },
    data: { linkedinEasyApply: false } });
  assert.deepEqual(job, { ...original, linkedinEasyApply: false });
});
