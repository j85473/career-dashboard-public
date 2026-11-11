import assert from 'node:assert/strict';
import test from 'node:test';
import type { AtsFirstCollectionPolicy } from '../../src/lib/prismaClient';
import { REVIEWED_FIRST_COLLECTION_POLICY_ID, isReviewedFirstCollection, reviewedFirstCollectionBoards,
  reviewedFirstCollectionReserveJobs, REVIEWED_PROVIDER_LAUNCH_BOARDS } from '../../src/lib/atsReviewedFirstCollection';
import { firstCollectionBodyLimits, reserveFirstCollection } from '../../src/lib/atsFirstCollectionAdmission';
import { selectNextAtsV2CoverageBoard } from '../../src/lib/atsAcquisitionDispatcherV2';
import { prisma } from '../../src/lib/prisma';

const board = { platform: 'clearcompany', slug: '11111111-1111-1111-1111-111111111111' };
const ordinary = { id: 'new-providers', mode: 'capacity', maxCatalogueJobs: 250, maxResponseBytes: 5242880 } as AtsFirstCollectionPolicy;
const reviewed = { ...ordinary, id: REVIEWED_FIRST_COLLECTION_POLICY_ID, maxUnfinished: 1, maxCatalogueJobs: 5000,
  pilotBoards: [`${board.platform}::${board.slug}`, 'symphony::hgv'] } as AtsFirstCollectionPolicy;

test('reviewed allowance is confined to exact reviewed boards and four explicit provider launches', () => {
  assert.deepEqual(reviewedFirstCollectionBoards(reviewed), [board, { platform: 'symphony', slug: 'hgv' }]);
  assert.equal(isReviewedFirstCollection(reviewed, { platform: 'symphony', slug: 'victoriassecret' }), false);
  assert.equal(isReviewedFirstCollection(reviewed, { ...board, slug: 'hrmdirect::unreviewed' }), false);
  for (const broken of [{ maxUnfinished: 2 }, { pilotBoards: ['clearcompany::hrmdirect::alias'] },
    { pilotBoards: ['symphony::unverified'] }, { maxCatalogueJobs: 10001 }, { id: 'new-providers' }]) {
    assert.deepEqual(reviewedFirstCollectionBoards({ ...reviewed, ...broken } as AtsFirstCollectionPolicy), []);
  }
  assert.equal(reviewedFirstCollectionReserveJobs(reviewed), 250);
});

test('each explicit provider launch retains the 250-job limit and cannot authorize a neighboring tenant', async () => {
  for (const launch of REVIEWED_PROVIDER_LAUNCH_BOARDS) {
    const exact = { ...reviewed, pilotBoards: [`${launch.platform}::${launch.slug}`] };
    assert.deepEqual(reviewedFirstCollectionBoards(exact), [launch]);
    assert.equal(isReviewedFirstCollection(exact, { ...launch, slug: 'unreviewed-neighbor' }), false);
    assert.deepEqual(reviewedFirstCollectionBoards({ ...exact, pilotBoards: [`${launch.platform}::unreviewed-neighbor`] }), []);
    const client = {
      atsCompany: { findUnique: async () => ({ firstCollectionState: 'ready', firstCollectionHoldReason: null }) },
      atsFirstCollectionPolicy: { findUnique: async () => exact },
    } as unknown as Parameters<typeof firstCollectionBodyLimits>[0];
    assert.equal((await firstCollectionBodyLimits(client, launch)).maximumJobs, 250);
  }
});

test('a reviewed board retains its allowance while held, without changing ordinary or established limits', async () => {
  let state = 'ready';
  let hold: string | null = null;
  const client = {
    atsCompany: { findUnique: async () => ({ firstCollectionState: state, firstCollectionHoldReason: hold }) },
    atsFirstCollectionPolicy: { findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === REVIEWED_FIRST_COLLECTION_POLICY_ID ? { ...reviewed, mode: 'held' } : ordinary },
  } as unknown as Parameters<typeof firstCollectionBodyLimits>[0];
  assert.deepEqual(await firstCollectionBodyLimits(client, board), { maximumJobs: 5000, maximumBytes: 5242880 });
  assert.deepEqual(await firstCollectionBodyLimits(client, { platform: 'symphony', slug: 'victoriassecret' }), { maximumJobs: 250, maximumBytes: 5242880 });
  state = 'established';
  assert.deepEqual(await firstCollectionBodyLimits(client, board), { maximumJobs: null, maximumBytes: 15 * 1024 * 1024 });
  state = 'admitted'; hold = 'Explicit saved review hold';
  await assert.rejects(firstCollectionBodyLimits(client, board), /Explicit saved review hold/);
});

test('reviewed reservation stops for every unfinished reviewed board, pressure, and either operator hold', async () => {
  let unfinished = 1, pressure = 0, globalMode = 'capacity', reviewedMode = 'capacity', reservations = 0;
  const tx = {
    $queryRaw: async () => [{ items: BigInt(0), bytes: BigInt(0), persistence: BigInt(pressure), totalPersistence: BigInt(pressure), gate: 'open' }],
    $executeRaw: async () => 0,
    atsCompany: {
      findUnique: async () => ({ firstCollectionState: 'ready', jobsFound: 4241 }),
      count: async () => unfinished,
      updateMany: async () => { reservations++; return { count: 1 }; },
    },
    atsFirstCollectionPolicy: {
      findUnique: async ({ where }: { where: { id: string } }) => where.id === REVIEWED_FIRST_COLLECTION_POLICY_ID
        ? { ...reviewed, mode: reviewedMode } : { ...ordinary, mode: globalMode },
      findUniqueOrThrow: async () => ({ ...reviewed, mode: reviewedMode }),
    },
  } as unknown as Parameters<typeof reserveFirstCollection>[0];
  assert.equal(await reserveFirstCollection(tx, board, 'retry-held-neighbor'), false);
  unfinished = 0; pressure = 1750;
  assert.equal(await reserveFirstCollection(tx, board, 'pressure'), false);
  pressure = 0; globalMode = 'held';
  assert.equal(await reserveFirstCollection(tx, board, 'global-hold'), false);
  globalMode = 'capacity'; reviewedMode = 'held';
  assert.equal(await reserveFirstCollection(tx, board, 'review-hold'), false);
  reviewedMode = 'capacity'; pressure = 1500;
  assert.equal(await reserveFirstCollection(tx, board, 'allowed'), true);
  assert.equal(reservations, 1);
});

test('the reviewed queue receives the next coverage turn before ordinary rotation lookup', async () => {
  const original = { query: prisma.$queryRaw, policy: prisma.atsFirstCollectionPolicy.findUnique,
    first: prisma.atsCompany.findFirst, count: prisma.atsCompany.count, many: prisma.atsCompany.findMany };
  const ready = { ...board, status: 'active', jobsFound: 251, firstCollectionState: 'ready', acquisitionEngine: 'v2' };
  prisma.$queryRaw = (async () => [{ items: BigInt(0), bytes: BigInt(0), persistence: BigInt(1500), totalPersistence: BigInt(1500), gate: 'open' }]) as typeof prisma.$queryRaw;
  prisma.atsFirstCollectionPolicy.findUnique = (async ({ where }: { where: { id: string } }) =>
    where.id === REVIEWED_FIRST_COLLECTION_POLICY_ID ? reviewed : ordinary) as unknown as typeof prisma.atsFirstCollectionPolicy.findUnique;
  prisma.atsCompany.findFirst = (async () => ready) as typeof prisma.atsCompany.findFirst;
  prisma.atsCompany.count = (async () => 0) as typeof prisma.atsCompany.count;
  prisma.atsCompany.findMany = (async () => { throw new Error('ordinary lookup must follow the reviewed turn'); }) as typeof prisma.atsCompany.findMany;
  try { assert.deepEqual(await selectNextAtsV2CoverageBoard(), ready); }
  finally {
    prisma.$queryRaw = original.query; prisma.atsFirstCollectionPolicy.findUnique = original.policy;
    prisma.atsCompany.findFirst = original.first; prisma.atsCompany.count = original.count; prisma.atsCompany.findMany = original.many;
  }
});
