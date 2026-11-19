import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '../prismaClient';
import { atsListingPauseWhere, pausedAtsListingPlatforms } from '../atsListingPause';
import { throttlePlatform } from '../atsProviderRequest';
import { claimNextAtsV2Continuation } from '../atsAcquisitionLedger';
import { selectNextAtsV2CoverageBoard } from '../atsAcquisitionDispatcherV2';
import { prisma } from '../prisma';

test('paused platforms combine local refusals with live durable cooldowns and reopen on expiry', () => {
  const now = new Date('2090-01-01T12:00:00Z');
  const circuits = [
    { provider: 'ATS-workday', state: 'open', openUntil: new Date(+now + 30_000), lastError: 'HTTP 429' },
    { provider: 'ATS-workable', state: 'open', openUntil: new Date(+now - 1), lastError: 'HTTP 429' },
    { provider: 'ATS-personio', state: 'open', openUntil: new Date(+now + 30_000),
      lastError: 'Transaction API error: Unable to start a transaction in the given time.' },
  ];
  assert.deepEqual(pausedAtsListingPlatforms(circuits, now), ['workday']);
  // A new local throttle must apply even while the durable snapshot is cached.
  throttlePlatform('workable', null, +now);
  assert.deepEqual(pausedAtsListingPlatforms(circuits, now), ['workable', 'workday']);
  assert.deepEqual(pausedAtsListingPlatforms(circuits, new Date(+now + 60_000)), []);
});

test('all continuation priorities retain pause, retry and lease guards without excluding drain phases', async () => {
  const now = new Date('2026-11-16T17:00:00Z');
  const reads: Prisma.AtsIngestionBatchWhereInput[] = [];
  const client = { atsIngestionBatch: {
    findFirst: async ({ where }: { where: Prisma.AtsIngestionBatchWhereInput }) => {
      reads.push(where); return null;
    },
    findMany: async ({ where }: { where: Prisma.AtsIngestionBatchWhereInput }) => {
      reads.push(where); return [];
    },
  } } as unknown as Pick<Prisma.TransactionClient, 'atsIngestionBatch'>;
  const pauseGuard = atsListingPauseWhere(['workday']);
  for (const listingConcurrencyLimit of [undefined, 1]) {
    reads.length = 0;
    assert.equal(await claimNextAtsV2Continuation({ client, now,
      listingConcurrencyLimit, pausedPlatforms: ['workday'] }), null);
    const nodes = (where: Prisma.AtsIngestionBatchWhereInput): Prisma.AtsIngestionBatchWhereInput[] => [where, ...(Array.isArray(where.AND) ? where.AND.flatMap(nodes) : [])];
    const selections = reads.flatMap(nodes).filter(where => 'status' in where);
    assert.ok(selections.length >= 4);
    for (const where of selections) {
      assert.deepEqual(where.OR, [{ nextAcquireAt: null }, { nextAcquireAt: { lte: now } }]);
      const guards = where.AND as Prisma.AtsIngestionBatchWhereInput[];
      assert.ok(guards.some(guard => JSON.stringify(guard) === JSON.stringify(pauseGuard)));
      assert.ok(guards.some(guard => JSON.stringify(guard).includes('acquisitionLeaseExpiresAt')));
    }
    assert.ok(selections.some(where => JSON.stringify(where.acquisitionPhase).includes('compaction')));
  }
});

test('assigned, overdue and recovery coverage all skip paused platforms before the candidate limit', async t => {
  const original = { query: prisma.$queryRaw, execute: prisma.$executeRaw, policy: prisma.atsFirstCollectionPolicy.findUnique,
    many: prisma.atsCompany.findMany };
  t.after(() => {
    prisma.$queryRaw = original.query;
    prisma.$executeRaw = original.execute;
    prisma.atsFirstCollectionPolicy.findUnique = original.policy;
    prisma.atsCompany.findMany = original.many;
  });
  const reads: Prisma.AtsCompanyWhereInput[] = [];
  prisma.$queryRaw = (async (query: Prisma.Sql) => {
    assert.ok(query.values.includes('workday'), 'the retained-evidence refresh must respect the listing pause');
    return [];
  }) as typeof prisma.$queryRaw;
  prisma.$executeRaw = (async () => 0) as typeof prisma.$executeRaw;
  prisma.atsFirstCollectionPolicy.findUnique = (async () => null) as typeof prisma.atsFirstCollectionPolicy.findUnique;
  prisma.atsCompany.findMany = (async (input) => {
    reads.push(input!.where!); return [];
  }) as typeof prisma.atsCompany.findMany;
  assert.equal(await selectNextAtsV2CoverageBoard(new Date(), false, ['workday']), null);
  assert.equal(reads.length, 4);
  for (const where of reads) {
    const platform = (where.AND as Prisma.AtsCompanyWhereInput[])[0].platform as Prisma.StringFilter;
    assert.ok((platform.notIn as string[]).includes('workday'));
    assert.ok(!(platform.notIn as string[]).includes('greenhouse'));
  }
});
