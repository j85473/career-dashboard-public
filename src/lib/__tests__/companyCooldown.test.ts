import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '../prismaClient';

import { companyIdentityKey, sameCompanyIdentity } from '../companyIdentity';
import {
  activeApplicationDecisionAt,
  activeCompanyCooldowns,
  companyCooldownUntil,
  effectiveCooldownDeadline,
  parkSameCompanyInboxJobs,
  reconcileCompanyCooldowns,
  resolveInboxAdmission,
} from '../companyCooldown';

function applications(id: string, company: string, secondAt: Date, employer?: string) {
  const firstAt = new Date(secondAt.valueOf() - 24 * 60 * 60 * 1000);
  return [
    { id: `${id}-earlier`, company, employer, updatedAt: firstAt, statusHistory: [{ status: 'applied', createdAt: firstAt }] },
    { id, company, employer, updatedAt: secondAt, statusHistory: [{ status: 'applied', createdAt: secondAt }] },
  ];
}

test('company identity aligns legal names and compact ATS slugs without fuzzy matching', () => {
  assert.equal(companyIdentityKey('HP, Inc.'), 'hp');
  assert.equal(companyIdentityKey('HP'), 'hp');
  assert.equal(companyIdentityKey('SharkNinja Operating LLC'), 'sharkninja');
  assert.equal(companyIdentityKey('sharkninjaoperatingllc'), 'sharkninja');
  assert.equal(sameCompanyIdentity('SharkNinja', 'sharkninjaoperatingllc'), true);
  assert.equal(sameCompanyIdentity('SharkNinja', 'Shark Robotics'), false);
  assert.equal(companyIdentityKey('3m.wd1'), '3m');
});

test('the cooldown starts at the original application decision, not enforcement time', () => {
  const appliedAt = new Date('2026-08-25T14:00:00.000Z');
  const decisionAt = activeApplicationDecisionAt([
    { status: 'interviewing', createdAt: new Date('2026-08-27T14:00:00.000Z') },
    { status: 'applied', createdAt: appliedAt },
    { status: 'inbox', createdAt: new Date('2026-08-24T14:00:00.000Z') },
  ], new Date('2026-08-27T15:00:00.000Z'));
  assert.equal(decisionAt.toISOString(), appliedAt.toISOString());
  assert.equal(companyCooldownUntil(decisionAt).toISOString(), '2026-08-30T14:00:00.000Z');
});

test('only distinct same-employer applications within five days start a fixed hold', async () => {
  const app = (id: string, day: number, company = 'Acme', canonicalUrl?: string) => ({
    ...applications(id, company, new Date(Date.UTC(2026, 8, day)))[1], canonicalUrl,
  });
  const url = 'https://jobs.example.com/acme/123';
  const first = app('first', 1, 'Acme, Inc.', url);
  const lastDay = app('second', 6);
  const third = app('third', 7);
  const recent = new Date('2026-09-08T00:00:00Z');
  const lookup = (rows: Array<ReturnType<typeof app>>, now = recent) => activeCompanyCooldowns({
    job: { findMany: async () => rows },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>, now);
  assert.equal((await lookup([first])).size, 0);
  assert.equal((await lookup([first, app('different-company', 3, 'Other')])).size, 0);
  assert.equal((await lookup([first, app('duplicate', 3, 'Acme', url)])).size, 0);
  assert.equal((await lookup([first, third])).size, 0);

  const hold = (await lookup([third, lastDay, first])).get('acme');
  assert.equal(hold?.id, lastDay.id);
  assert.equal(hold?.cooldownUntil.toISOString(), '2026-09-11T00:00:00.000Z');
  assert.equal((await lookup([first, lastDay, third], new Date('2026-09-11T00:00:00Z'))).size, 0);
});

test('saved cooldown dates are shortened to the qualifying deadline or become due now', () => {
  const now = new Date('2026-09-08T00:00:00Z');
  const original = new Date('2026-09-25T00:00:00Z');
  const current = new Date('2026-09-11T00:00:00Z');
  const authority = { id: 'second', decisionAt: new Date('2026-09-06T00:00:00Z'), cooldownUntil: current };
  assert.equal(effectiveCooldownDeadline(original, authority, now), current);
  assert.equal(effectiveCooldownDeadline(original, undefined, now), now);
  const sooner = new Date('2026-09-10T00:00:00Z');
  assert.equal(effectiveCooldownDeadline(sooner, authority, now), sooner);
});

test('Inbox admission catches a recent pair under a legal-name alias', async () => {
  const appliedAt = new Date('2026-08-25T14:00:00.000Z');
  const store = {
    job: {
      findMany: async () => applications('applied-job', 'sharkninjaoperatingllc', appliedAt),
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

  const admission = await resolveInboxAdmission({
    employer: null,
    title: 'Account Manager', location: null,
    jobId: 'new-job',
    company: 'SharkNinja',
    source: 'Himalayas',
    proposedStatus: 'inbox',
    now: new Date('2026-08-27T12:00:00.000Z'),
    store,
    actor: 'user',
  });
  assert.equal(admission.status, 'cooldown');
  assert.equal(admission.authorityJobId, 'applied-job');
  assert.equal(admission.cooldownUntil?.toISOString(), '2026-08-30T14:00:00.000Z');
});

test('expired application windows and Manual Imports do not block Inbox', async () => {
  let queries = 0;
  const oldAppliedAt = new Date('2026-07-01T00:00:00.000Z');
  const store = {
    job: {
      findMany: async () => {
        queries += 1;
        return [{
          id: 'old-application', company: 'HP', updatedAt: oldAppliedAt,
          statusHistory: [{ status: 'applied', createdAt: oldAppliedAt }],
        }];
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

  const expired = await resolveInboxAdmission({
    employer: null,
    title: 'Account Manager', location: null,
    jobId: 'hp-new', company: 'HP Inc.', source: 'Himalayas', proposedStatus: 'inbox',
    now: new Date('2026-08-27T00:00:00.000Z'), store, actor: 'user',
  });
  assert.equal(expired.status, 'inbox');
  assert.equal(expired.cooldownUntil, null);

  const manual = await resolveInboxAdmission({
    employer: null,
    title: 'Account Manager', location: null,
    jobId: 'manual', company: 'HP', source: 'Manual Import', proposedStatus: 'inbox',
    now: new Date('2026-08-27T00:00:00.000Z'), store, actor: 'user',
  });
  assert.equal(manual.status, 'inbox');
  assert.equal(queries, 1, 'Manual Import protection should bypass application queries');
});

test('the qualifying application parks matching current Inbox rows with a CAS write', async () => {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const store = {
    job: {
      findMany: async ({ where }: { where: { status: unknown } }) => typeof where.status === 'object'
        ? applications('applied-job', 'sharkninjaoperatingllc', new Date('2026-08-25T00:00:00.000Z')) : [
        { id: 'alias-inbox', company: 'SharkNinja Operating LLC' },
        { id: 'other-inbox', company: 'Shark Robotics' },
      ],
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const ids = await parkSameCompanyInboxJobs({
    authorityJobId: 'applied-job',
    company: 'sharkninjaoperatingllc',
    now: new Date('2026-08-27T00:00:00.000Z'),
    store,
  });
  assert.deepEqual(ids, ['alias-inbox']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.status, 'inbox');
  assert.equal((updates[0].data.cooldownUntil as Date).toISOString(), '2026-08-30T00:00:00.000Z');
});

test('reconciliation scans and mutates Inbox only, preserving other decisions', async () => {
  const queries: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const store = {
    job: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        if ('status' in args.where && typeof args.where.status === 'object') {
          return applications('hp-applied', 'HP Inc.', new Date('2026-08-25T00:00:00.000Z'));
        }
        return [{ id: 'hp-inbox', company: 'HP' }];
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const ids = await reconcileCompanyCooldowns({
    now: new Date('2026-08-27T00:00:00.000Z'), store,
  });
  assert.deepEqual(ids, ['hp-inbox']);
  assert.equal(queries[1].status, 'inbox');
  assert.equal(updates[0].where.status, 'inbox');
  assert.equal((updates[0].data.cooldownUntil as Date).toISOString(), '2026-08-30T00:00:00.000Z');
});

const zoetisAliases = [
  'Zoetis', '110 - Zoetis US LLC', '6J2 - Zoetis Services LLC',
  'Zoetis US LLC', 'Zoetis Services LLC', 'zoetis.wd5',
];
const zoetisAppliedAt = new Date('2026-09-06T16:43:05.037Z');
const zoetisNow = new Date('2026-09-06T17:00:00.000Z');
const zoetisUntil = '2026-09-11T16:43:05.037Z';

test('a shared Remote Quest Jobs label never establishes an employer cooldown', async () => {
  const publisher = 'remote quest jobs';
  const store = { job: {
    findMany: async () => applications('publisher-application', publisher, zoetisAppliedAt, publisher),
    updateMany: async () => { assert.fail('publisher grouping must not write card decisions or scores'); },
  } } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;
  for (const employer of [null, 'Remote Quest Jobs', 'REMOTE QUEST JOBS, LLC', 'HP']) {
    const admission = await resolveInboxAdmission({
      jobId: 'unrelated-job', title: 'Account Manager', location: 'Remote',
      company: publisher, employer, source: 'JSearch', proposedStatus: 'inbox',
      now: zoetisNow, store, actor: 'user',
    });
    assert.equal(admission.status, 'inbox');
    assert.equal(admission.authorityJobId, null);
  }
  assert.deepEqual(await parkSameCompanyInboxJobs({
    authorityJobId: 'publisher-application', company: publisher, employer: publisher,
    now: zoetisNow, store,
  }), []);
  assert.deepEqual(await reconcileCompanyCooldowns({ now: zoetisNow, store }), []);
});

test('resolved employers behind the publisher keep separate cooldowns across admission and parking', async () => {
  const publisher = 'remote quest jobs';
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const store = { job: {
    findMany: async (args: { where: { status: unknown } }) => typeof args.where.status === 'object'
      ? applications('hp-application', publisher, zoetisAppliedAt, 'HP Inc.') : [
      { id: 'hp-inbox', company: publisher, employer: 'HP' },
      { id: 'different-employer', company: publisher, employer: 'Zoetis' },
      { id: 'unresolved-publisher', company: publisher, employer: publisher },
    ],
    updateMany: async (args: typeof updates[number]) => { updates.push(args); return { count: 1 }; },
  } } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;
  for (const employer of ['HP', 'Zoetis', publisher]) {
    const admission = await resolveInboxAdmission({
      jobId: 'new-job', title: 'Account Manager', location: 'Remote',
      company: publisher, employer, source: 'JSearch', proposedStatus: 'inbox',
      now: zoetisNow, store, actor: 'user',
    });
    assert.equal(admission.status, employer === 'HP' ? 'cooldown' : 'inbox');
  }
  assert.deepEqual(await parkSameCompanyInboxJobs({
    authorityJobId: 'hp-application', company: publisher, employer: 'HP Inc.',
    now: zoetisNow, store,
  }), ['hp-inbox']);
  assert.deepEqual(await reconcileCompanyCooldowns({ now: zoetisNow, store }), ['hp-inbox']);
  for (const update of updates) {
    assert.equal(update.where.id, 'hp-inbox');
    assert.deepEqual(Object.keys(update.data).sort(), ['cooldownUntil', 'status'], 'saved scores and employer fields are never rewritten');
  }
});

test('Zoetis employer aliases share cooldown in either direction without changing posting identity', async () => {
  for (const appliedCompany of zoetisAliases) {
    const store = {
      job: { findMany: async () => applications('applied-job', appliedCompany, zoetisAppliedAt) },
    } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;
    for (const company of [...zoetisAliases, 'Zoetis Consulting', '110 - Other US LLC']) {
      const admission = await resolveInboxAdmission({
    employer: null,
    title: 'Account Manager', location: null,
        jobId: 'inbox-job', company, source: 'ATS-workday',
        proposedStatus: 'inbox', now: zoetisNow, store, actor: 'user',
      });
      const matches = zoetisAliases.includes(company);
      assert.equal(admission.status, matches ? 'cooldown' : 'inbox', `${appliedCompany} -> ${company}`);
      assert.equal(admission.cooldownUntil?.toISOString() ?? null, matches ? zoetisUntil : null);
    }
    for (const [source, proposedStatus] of [['Manual Import', 'inbox'], ['ATS-workday', 'bookmarked']]) {
      const admission = await resolveInboxAdmission({
    employer: null,
    title: 'Account Manager', location: null,
        jobId: 'protected-job', company: 'Zoetis', source, proposedStatus, now: zoetisNow, store, actor: 'user',
      });
      assert.equal(admission.status, proposedStatus);
      assert.equal(admission.cooldownUntil, null);
    }
    const expired = await resolveInboxAdmission({
    employer: null,
    title: 'Account Manager', location: null,
      jobId: 'inbox-job', company: 'Zoetis', source: 'ATS-workday',
      proposedStatus: 'inbox', now: new Date(zoetisUntil), store, actor: 'user',
    });
    assert.equal(expired.status, 'inbox');
  }
  assert.notEqual(companyIdentityKey('110 - Zoetis US LLC'), companyIdentityKey('6J2 - Zoetis Services LLC'));
});

for (const operation of ['application', 'reconciliation'] as const) {
  test(`${operation} parks the three Zoetis Inbox records while preserving scores and protected jobs`, async () => {
    const rows = [
      { id: 'senior-workday', company: '110 - Zoetis US LLC', status: 'inbox', source: 'ATS-workday' },
      { id: 'senior-himalayas', company: 'Zoetis', status: 'inbox', source: 'Himalayas' },
      { id: 'retail-himalayas', company: 'Zoetis', status: 'inbox', source: null },
      { id: 'other-company', company: 'Zoetis Consulting', status: 'inbox', source: 'ATS-workday' },
      { id: 'manual', company: 'Zoetis', status: 'inbox', source: 'Manual Import' },
      ...['applied', 'interviewing', 'bookmarked', 'passed', 'dismissed'].map(status => ({
        id: status, company: 'Zoetis', status, source: 'ATS-workday',
      })),
    ];
    const queries: unknown[] = [];
    const updates: Array<{ where: { id: string; status: string; AND: unknown }; data: Record<string, unknown> }> = [];
    const store = { job: {
      findMany: async (args: { where: { status: unknown; AND?: unknown } }) => {
        queries.push(args.where);
        if (typeof args.where.status === 'object') return applications('applied-job', '6J2 - Zoetis Services LLC', zoetisAppliedAt);
        assert.equal(args.where.status, 'inbox');
        assert.deepEqual(args.where.AND, [{ OR: [{ source: null }, { source: { not: 'Manual Import' } }] }]);
        return rows.filter(row => row.status === 'inbox' && row.source !== 'Manual Import');
      },
      updateMany: async (args: typeof updates[number]) => {
        updates.push(args);
        assert.equal(args.where.status, 'inbox');
        assert.deepEqual(args.where.AND, [{ OR: [{ source: null }, { source: { not: 'Manual Import' } }] }]);
        assert.deepEqual(Object.keys(args.data).sort(), ['cooldownUntil', 'status'], 'scores, identity and application history must not be rewritten');
        assert.equal(args.data.status, 'cooldown');
        assert.equal((args.data.cooldownUntil as Date).toISOString(), zoetisUntil);
        // Simulate a concurrent human decision after the candidate read.
        return { count: args.where.id === 'retail-himalayas' ? 0 : 1 };
      },
    } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
    const ids = operation === 'application'
      ? await parkSameCompanyInboxJobs({
        authorityJobId: 'applied-job', company: '6J2 - Zoetis Services LLC',
        now: zoetisNow, store,
      })
      : await reconcileCompanyCooldowns({ now: zoetisNow, store });
    assert.deepEqual(updates.map(update => update.where.id), ['senior-workday', 'senior-himalayas', 'retail-himalayas']);
    assert.deepEqual(ids, ['senior-workday', 'senior-himalayas'], 'only successfully parked rows are reported');
    assert.equal(queries.length, 2);
  });
}

test('Jobgether listings use the ordinary company cooldown', async () => {
  let queries = 0;
  const store = { job: { findMany: async () => {
    queries += 1;
    return applications('jobgether-applied', 'Jobgether', zoetisAppliedAt);
  } } } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;
  for (const company of ['Jobgether', ' JOBGETHER ', 'Jobgether Inc.']) {
    const admission = await resolveInboxAdmission({
    employer: null,
      jobId: 'jobgether-inbox', title: 'Account Manager', location: null,
      company, source: 'ATS', proposedStatus: 'inbox', now: zoetisNow, store, actor: 'user',
    });
    assert.equal(admission.status, 'cooldown');
    assert.equal(admission.cooldownUntil?.toISOString(), zoetisUntil);
    assert.equal(admission.authorityJobId, 'jobgether-applied');
  }
  assert.equal(queries, 3, 'each admission checks company cooldown authority');
  assert.equal(companyIdentityKey('Jobgether'), 'jobgether');
});

test('a second Jobgether application parks its other Inbox listings', async () => {
  const store = { job: {
    findMany: async ({ where }: { where: { status: unknown } }) => typeof where.status === 'object'
      ? applications('jobgether-applied', 'Jobgether', zoetisAppliedAt)
      : [{ id: 'jobgether-inbox', company: 'Jobgether Inc.' }],
    updateMany: async () => ({ count: 1 }),
  } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  const ids = await parkSameCompanyInboxJobs({
    authorityJobId: 'jobgether-applied', company: 'Jobgether',
    now: zoetisNow, store,
  });
  assert.deepEqual(ids, ['jobgether-inbox']);
});

test('cooldown reconciliation includes Jobgether applications like other employers', async () => {
  const parkedIds: string[] = [];
  const store = { job: {
    findMany: async ({ where }: { where: { status: unknown } }) => (
      typeof where.status === 'object'
        ? ['Jobgether', 'Acme'].flatMap(company => applications(`${company}-applied`, company, zoetisAppliedAt))
        : ['Jobgether', 'Acme'].map(company => ({ id: `${company}-inbox`, company }))
    ),
    updateMany: async ({ where }: { where: { id: string } }) => {
      parkedIds.push(where.id);
      return { count: 1 };
    },
  } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  assert.deepEqual(await reconcileCompanyCooldowns({ now: zoetisNow, store }), ['Jobgether-inbox', 'Acme-inbox']);
  assert.deepEqual(parkedIds, ['Jobgether-inbox', 'Acme-inbox']);
});
