import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job, Prisma } from '../prismaClient';
import {
  findDirectAtsReprint,
  isDirectAtsReprint,
  type DuplicateJobIdentity,
} from '../jobIngestion';
import { consolidateStoredAtsReprint, preferIncomingDirectAtsSource } from '../atsDuplicateConsolidation';
import { prisma } from '../prisma';

const body = 'Develop partner relationships and manage the Central US territory. Lead account planning and customer reviews. '.repeat(15);
const ats: DuplicateJobIdentity = {
  company: 'rfsmart', title: 'Strategic Account Executive - Central US Territory',
  location: 'Distributed - US', description: body, source: 'ATS-greenhouse', sourceId: '5397128008',
  url: 'https://job-boards.greenhouse.io/rfsmart/jobs/5397128008',
};
const aggregate: DuplicateJobIdentity = {
  ...ats, company: 'RF-SMART', location: 'United States', source: 'Himalayas', sourceId: 'himalayas-1',
  url: 'https://himalayas.app/companies/rf-smart/jobs/strategic-account-executive-central-us-territory',
  description: body.replaceAll('territory. Lead', 'territory.Lead') + '\nOriginally posted on Himalayas',
};

test('the ATS and Himalayas reprint match in either arrival order despite formatting', () => {
  assert.equal(isDirectAtsReprint(ats, aggregate), true);
  assert.equal(isDirectAtsReprint(aggregate, ats), true);
  assert.equal(isDirectAtsReprint({ ...ats, description: body + ' Contact us at privacy@rfsmart.com.' },
    { ...aggregate, description: body + ' Contact us at .\nOriginally posted on Himalayas' }), true);
});

test('different requirements, territories, employers, ATS requisitions and short descriptions never match', () => {
  for (const change of [
    { description: body + ' Requires a veterinary license.' },
    { description: body.slice(0, -20) },
    { description: 'Short description' },
    { company: 'RF Smart Consulting' },
    { title: 'Senior Strategic Account Executive - Central US Territory' },
    { location: 'Canada' },
    { source: 'ATS-greenhouse' },
    { url: 'https://job-boards.greenhouse.io/rfsmart/jobs/5397128999' },
  ]) assert.equal(isDirectAtsReprint(ats, { ...aggregate, ...change }), false, JSON.stringify(change));
  assert.equal(isDirectAtsReprint({ ...ats, title: 'Account Manager - Milwaukee, WI' },
    { ...aggregate, title: 'Account Manager - Minneapolis, MN' }), false);
  assert.equal(isDirectAtsReprint({ ...ats, url: 'https://acme.wd1.myworkdayjobs.com/jobs/job/US/Role_R10001' },
    { ...aggregate, url: 'https://acme.wd1.myworkdayjobs.com/jobs/job/US/Role_R10002' }), false);
});

test('stored ATS retrieval uses the complete employer identity and still refuses ambiguous requisitions', async () => {
  const candidates = [
    {
      ...ats,
      id: 'ats-older',
      createdAt: new Date('2026-07-24T10:50:48Z'),
      passReason: null,
      url: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/US-Remote/Role_JR114209',
    },
    {
      ...ats,
      id: 'ats-newer',
      createdAt: new Date('2026-09-16T06:21:18Z'),
      passReason: null,
      url: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/US-Remote/Role_JR115981',
    },
  ];
  let where: unknown = null;
  const store = {
    job: { findMany: async (args: { where: unknown }) => { where = args.where; return candidates; } },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  assert.equal(
    await findDirectAtsReprint(aggregate, undefined, store),
    null,
    'a caller that needs one canonical requisition must still refuse ambiguity',
  );
  const serializedWhere = JSON.stringify(where);
  assert.match(serializedWhere, /rf smart/);
  assert.match(serializedWhere, /rfsmart/);
  assert.doesNotMatch(serializedWhere, /"contains":"rfs"/);
});

test('a common company prefix cannot saturate and hide a unique exact ATS reprint', async () => {
  const serviceTitanAggregate: DuplicateJobIdentity = {
    ...aggregate,
    company: 'ServiceTitan',
    title: 'Customer Success Manager, Enterprise',
    location: 'United States',
  };
  const serviceTitanAts = {
    ...ats,
    id: 'existing-servicetitan',
    createdAt: new Date('2026-07-24T10:50:48Z'),
    passReason: null,
    company: 'servicetitan.wd1',
    title: serviceTitanAggregate.title,
    location: 'US Remote',
    url: 'https://servicetitan.wd1.myworkdayjobs.com/en-US/ServiceTitan/job/US-Remote/Customer-Success-Manager--Enterprise_JR114209',
  };
  let where: unknown = null;
  const store = {
    job: { findMany: async (args: { where: unknown }) => { where = args.where; return [serviceTitanAts]; } },
  } as unknown as Pick<Prisma.TransactionClient, 'job'>;

  const match = await findDirectAtsReprint(serviceTitanAggregate, undefined, store);
  assert.equal(match?.id, serviceTitanAts.id);
  const serializedWhere = JSON.stringify(where);
  assert.match(serializedWhere, /servicetitan/);
  assert.doesNotMatch(serializedWhere, /"contains":"ser"/);
});

test('a later ATS sighting promotes the source on the saved card without touching scores or decisions', async () => {
  const original = { ...aggregate, id: 'saved', status: 'applied', aimFitScore: 84, reqFitScore: 84,
    submittedResume: '/saved/resume.docx', canonicalUrl: aggregate.url } as Job;
  let saved = structuredClone(original);
  const writes: Record<string, unknown>[] = [];
  const observations: unknown[] = [];
  const tx = {
    $queryRaw: async () => [],
    job: {
      findUnique: async ({ where }: { where: { id?: string } }) => where.id ? saved : null,
      update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); saved = { ...saved, ...data }; return saved; },
    },
    jobSourceObservation: { upsert: async (args: unknown) => { observations.push(args); } },
  } as unknown as Prisma.TransactionClient;
  await preferIncomingDirectAtsSource(tx, 'saved', ats);
  assert.equal(saved.source, 'ATS-greenhouse');
  assert.equal(saved.url, ats.url);
  for (const key of ['id', 'status', 'aimFitScore', 'reqFitScore', 'submittedResume', 'description', 'company', 'title'] as const)
    assert.equal(saved[key], original[key], key);
  assert.deepEqual(Object.keys(writes[0]).sort(), ['canonicalUrl', 'postingIdentity', 'source', 'sourceId', 'updatedAt', 'url']);
  assert.equal(observations.length, 1);
  await preferIncomingDirectAtsSource(tx, 'saved', aggregate);
  assert.equal(writes.length, 1, 'a later aggregator cannot replace the ATS source');
});

test('rediscovering two scored copies leaves their scores visible and opens merge review', async () => {
  const defaults = { status: 'inbox', passReason: null, updatedAt: new Date(), tailoringStaged: false,
    submittedResume: null, aimFitScore: 84, reqFitScore: 81, fitScore: null, scoringStatus: 'scored' };
  const direct = { ...defaults, ...ats, id: 'ats', observations: [] };
  const publisher = { ...defaults, ...aggregate, id: 'aggregate', observations: [] };
  const events: Array<{ eventType: string; jobId: string }> = [];
  const tx = {
    $queryRaw: async (sql: TemplateStringsArray) => sql[0].includes('lower("canonicalUrl")') ? [{ id: 'ats' }] : [],
    $executeRaw: async () => 0,
    job: {
      findFirst: async () => publisher,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        [direct, publisher].filter(job => where.id.in.includes(job.id)),
    },
    scoringBatchItem: { count: async () => 0 },
    jobPipelineEvent: { findMany: async () => [], upsert: async ({ create }: { create: typeof events[number] }) => events.push(create) },
  } as unknown as Prisma.TransactionClient;
  const store = {
    job: { findFirst: async () => publisher, findMany: async () => [direct] },
    $transaction: async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => callback(tx),
  } as unknown as Pick<typeof prisma, 'job' | '$transaction'>;
  assert.equal(await consolidateStoredAtsReprint('aggregate', true, store), null);
  assert.deepEqual(events.map(({ eventType, jobId }) => [eventType, jobId]), [['canonical_merge_review', publisher.id]]);
  assert.ok([direct, publisher].every(row => row.status === 'inbox' && row.aimFitScore === 84 && row.reqFitScore === 81));
});
