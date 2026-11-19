import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job, Prisma } from '../prismaClient';
import { recheckPostingDisposition } from '../savedPostingOwner';

const job = { id: 'owner', title: 'Channel Account Manager', company: 'Example', source: 'ATS-greenhouse',
  url: 'https://boards.greenhouse.io/example/jobs/112233', location: 'Germany', updatedAt: new Date(),
  status: 'archived', scoringStatus: 'skipped', fitScore: null, aimFitScore: null, reqFitScore: null,
  passReason: 'Locally triaged out: Location outside the searched geographies (Germany)' } as Job;
const facts = { title: job.title, company: job.company, url: job.url!, location: 'Minneapolis, MN', description:
  'As a Channel Account Manager, you will build distributor partnerships, manage a sales territory, and grow existing accounts. '.repeat(15) };
function store(guard: { human?: boolean; scores?: boolean; lease?: boolean; prefilterReceipt?: boolean } = {}) {
  const writes: Prisma.JobUpdateInput[] = [];
  const tx = { job: { update: async ({ data }: { data: Prisma.JobUpdateInput }) => writes.push(data) },
    companyNameRule: { findMany: async () => [] },
    jobScoreEvent: { count: async () => Number(!!guard.scores) },
    scoringBatchItem: { count: async () => Number(!!guard.lease) },
    jobPipelineEvent: {
      findMany: async () => guard.human ? [{ jobId: job.id, id: 'decision', occurredAt: new Date(),
        eventType: 'user_reject', details: { actor: 'user', nextStatus: 'archived' } }] : [],
      findFirst: async () => guard.prefilterReceipt ? { id: 'prefilter' } : null,
      upsert: async () => ({}),
    } } as unknown as Prisma.TransactionClient;
  return { tx, writes };
}

test('a current employer posting can restore an unscored automatic rejection', async () => {
  const { tx, writes } = store();
  assert.ok(await recheckPostingDisposition(tx, job, facts));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'pending_af');
  assert.equal(writes[0].location, facts.location);
  assert.equal(writes[0].passReason, null);
  assert.equal('aimFitScore' in writes[0], false);
});

test('historical, incomplete, or still-disqualifying facts keep the saved disposition', async () => {
  const { tx, writes } = store();
  for (const evidence of [undefined, { ...facts, location: 'Unknown Location' }, { ...facts, location: 'Germany' }]) {
    await recheckPostingDisposition(tx, job, evidence);
  }
  assert.equal(writes.length, 0);
});

test('an explicit pass, projected or historical score, and active scoring lease protect the owner', async () => {
  for (const [card, guard] of [[job, { human: true }], [{ ...job, aimFitScore: 83 }, {}],
    [job, { scores: true }], [job, { lease: true }]] as const) {
    const { tx, writes } = store(guard);
    await recheckPostingDisposition(tx, card, facts);
    assert.equal(writes.length, 0);
  }
});

test('non-geographic rejections require an original intake receipt before restoration', async () => {
  for (const prefilterReceipt of [false, true]) {
    const { tx, writes } = store({ prefilterReceipt });
    await recheckPostingDisposition(tx, { ...job, passReason: 'Excluded role title' }, facts);
    assert.equal(writes.length, Number(prefilterReceipt));
  }
});
