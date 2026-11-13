import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PrismaClient } from '../prismaClient';
import JobCard from '../../components/JobCard';
import { withJobApplicationContext } from '../jobApplicationContext';
import { CONSOLIDATED_REASON_PREFIX } from '../jobConsolidationReason';
import { projectJobListScoreAuthority, projectJobScoreAuthority } from '../scoreAuthority';

const reason = `${CONSOLIDATED_REASON_PREFIX}applied-card`;
const applicationDate = new Date('2026-09-24T18:33:03.990Z');
const survivor = { id: 'applied-card', title: 'Field Sales Representative - Minnesota',
  company: 'Mark Anthony Group', employer: 'Mark Anthony Group', status: 'applied', passReason: null };
const copy = { id: 'copy', title: survivor.title, company: survivor.company,
  status: 'dismissed', passReason: reason, aimFitScore: 87, reqFitScore: 92 };
const score = { evaluationType: 'standard', passed: true, aimFitScore: 87, experienceFitScore: 92,
  aimReason: 'Strong distributor fit.', experienceReason: 'Direct beverage experience.', staleAt: null };

for (const project of [projectJobScoreAuthority, projectJobListScoreAuthority]) {
  test(`${project.name} preserves the combined explanation and passing scores`, () => {
    const result = project(copy, score);
    assert.equal(result.passReason, reason);
    assert.equal(result.aimFitScore, 87);
    assert.equal(result.reqFitScore, 92);
    assert.equal(result.scoreAuthorityState, 'current');
  });
}

function storeFor(rows: Array<Omit<typeof survivor, 'passReason'> & { passReason: string | null }>, queries: string[] = []) {
  return {
    job: { findMany: async (query: { where: { id: { in: string[] } } }) => {
      queries.push('jobs');
      return rows.filter(row => query.where.id.in.includes(row.id));
    } },
    jobStatusHistory: { findMany: async (query: { where: { status?: string } }) => {
      queries.push('history');
      if (query.where.status === 'interviewing') return [];
      return [{ jobId: survivor.id, status: 'applied', createdAt: applicationDate }];
    } },
  } as unknown as Pick<PrismaClient, 'job' | 'jobStatusHistory'>;
}

test('combined copy exposes the original application without changing either card or its scores', async () => {
  const before = structuredClone(copy);
  const [result] = await withJobApplicationContext([copy], storeFor([survivor]));
  assert.deepEqual(result.combinedInto, {
    id: survivor.id, title: survivor.title, company: survivor.company,
    status: 'applied', alreadyApplied: true, appliedAt: applicationDate,
  });
  assert.equal(result.appliedAt, null);
  assert.deepEqual(copy, before);
  assert.equal(result.aimFitScore, 87);
  const html = renderToStaticMarkup(React.createElement(JobCard, {
    job: { ...result, appliedAt: null, combinedInto: { ...result.combinedInto!, appliedAt: applicationDate.toISOString() } },
    onSelect: () => {},
  }));
  assert.match(html, /Already applied · Sep 24, 2026/);
});

test('combining with a card that was never applied to does not claim an application', async () => {
  const [result] = await withJobApplicationContext([copy], storeFor([{ ...survivor, status: 'bookmarked' }]));
  assert.equal(result.combinedInto?.alreadyApplied, false);
  assert.equal(result.combinedInto?.appliedAt, null);
});

test('ordinary pages check interview history without querying related jobs or inferring an application from employer', async () => {
  const queries: string[] = [];
  const [result] = await withJobApplicationContext([{ ...copy, status: 'inbox', passReason: null }], storeFor([survivor], queries));
  assert.equal(result.combinedInto, null);
  assert.deepEqual(queries, ['history']);
  assert.equal(result.hasInterviewHistory, false);
});

test('missing and cyclic consolidation targets do not invent an application', async () => {
  assert.equal((await withJobApplicationContext([copy], storeFor([])))[0].combinedInto, null);
  const cyclic = { ...survivor, passReason: `${CONSOLIDATED_REASON_PREFIX}copy` };
  const rows = [cyclic, { ...survivor, id: copy.id, passReason: reason }];
  assert.equal((await withJobApplicationContext([copy], storeFor(rows)))[0].combinedInto, null);
});

test('a second consolidation still reaches the saved application', async () => {
  const middle = { ...survivor, id: 'middle', status: 'dismissed', passReason: reason };
  const [result] = await withJobApplicationContext([{ ...copy, passReason: `${CONSOLIDATED_REASON_PREFIX}middle` }], storeFor([middle, survivor]));
  assert.equal(result.combinedInto?.id, survivor.id);
  assert.equal(result.combinedInto?.appliedAt, applicationDate);
});

test('interview document eligibility survives later statuses without relying on remaining attachments', async () => {
  const jobs = [
    { id: 'never', status: 'applied', aimFitScore: 72, attachments: [] },
    { id: 'current', status: 'interviewing', aimFitScore: 85, attachments: [] },
    { id: 'returned', status: 'applied', aimFitScore: 88, attachments: [] },
    { id: 'bookmarked', status: 'bookmarked', aimFitScore: 90, attachments: [] },
    { id: 'passed', status: 'passed', aimFitScore: 70, attachments: [] },
  ];
  const before = structuredClone(jobs);
  const queries: unknown[] = [];
  const store = {
    job: { findMany: async () => { throw new Error('No consolidation lookup expected'); } },
    jobStatusHistory: { findMany: async (query: { where: { status?: string } }) => {
      if (query.where.status !== 'interviewing') return [];
      queries.push(query);
      return ['returned', 'bookmarked', 'passed'].map(jobId => ({ jobId }));
    } },
  } as unknown as Pick<PrismaClient, 'job' | 'jobStatusHistory'>;
  const result = await withJobApplicationContext(jobs, store);
  assert.deepEqual(result.map(job => [job.id, job.hasInterviewHistory]), [
    ['never', false], ['current', true], ['returned', true], ['bookmarked', true], ['passed', true],
  ]);
  assert.deepEqual(queries, [{ where: { jobId: { in: ['never', 'returned', 'bookmarked', 'passed'] }, status: 'interviewing' },
    select: { jobId: true }, distinct: ['jobId'] }]);
  assert.deepEqual(jobs, before);
});
