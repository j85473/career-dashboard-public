import assert from 'node:assert/strict';
import test from 'node:test';
import { ATS_COHORT_PRESSURE_LISTING_CONCURRENCY, ATS_PRESSURE_LISTING_CONCURRENCY, withAtsListingCapacity } from '../atsContinuationCapacity';
import { findAtsContinuationCandidate } from '../atsAcquisitionLedger';
import type { Prisma } from '../prismaClient';
import { ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK, ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK } from '../atsAcquisitionPressure';

const now = new Date('2026-10-07T16:00:00Z');

test('eight competing workers can reserve only one listing lease when drain work exists', async () => {
  let lockTail = Promise.resolve();
  let liveListings = 0;
  const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    let unlock = () => {};
    const transaction = {
      $executeRaw: async () => {
        const previous = lockTail;
        lockTail = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        return 0;
      },
      atsIngestionBatch: { findFirst: async () => ({ id: 'unfinished-drain' }),
        count: async () => liveListings },
    } as unknown as Parameters<typeof withAtsListingCapacity>[0];
    try {
      return await withAtsListingCapacity(transaction, now, ATS_PRESSURE_LISTING_CONCURRENCY, async () => {
        // Yield between count and claim so missing serialization would allow
        // all eight workers to spend the same apparently available slot.
        await new Promise((resolve) => setTimeout(resolve, 1));
        liveListings += 1;
        return index;
      });
    } finally { unlock(); }
  }));
  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(liveListings, 1);
});

test('an all-listing backlog can use idle capacity to create drainable batches', async () => {
  let claims = 0;
  const transaction = { $executeRaw: async () => 0,
    $queryRaw: async () => [{ items: BigInt(0), bytes: BigInt(0), unfinished: BigInt(0) }],
    atsIngestionBatch: { findFirst: async () => null,
      count: async () => { throw new Error('No drain inventory means no producer cap'); } },
  } as unknown as Parameters<typeof withAtsListingCapacity>[0];
  for (let i = 0; i < 8; i += 1) {
    assert.equal(await withAtsListingCapacity(transaction, now, 1, async () => ++claims), i + 1);
  }
});

test('a large saved listing backlog can borrow idle workers without lending new intake its allowance', async () => {
  let claims = 0;
  let drain: { id: string } | null = null;
  const volume = { items: BigInt(1000), bytes: BigInt(1000000), unfinished: BigInt(100) };
  const transaction = { $executeRaw: async () => 0, $queryRaw: async () => [volume],
    atsIngestionBatch: { findFirst: async () => drain, count: async () => claims },
  } as unknown as Parameters<typeof withAtsListingCapacity>[0];
  const claim = async () => ++claims;
  for (let i = 0; i < 8; i++)
    assert.equal(await withAtsListingCapacity(transaction, now, 2, claim, { existingListing: true }), i + 1);
  assert.equal(await withAtsListingCapacity(transaction, now, 2, claim), null, 'new intake retains the bounded producer allowance');
  drain = { id: 'new-processing-work' };
  assert.equal(await withAtsListingCapacity(transaction, now, 2, claim, { existingListing: true }), null,
    'new downstream demand stops further loans without interrupting owned work');
  drain = null;
  volume.items = BigInt(ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK / 2);
  assert.equal(await withAtsListingCapacity(transaction, now, 2, claim, { existingListing: true }), null);
  volume.items = BigInt(1000);
  volume.bytes = ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK / BigInt(2);
  assert.equal(await withAtsListingCapacity(transaction, now, 2, claim, { existingListing: true }), null);
  assert.equal(claims, 8, 'retained volume stops lending at either admission threshold');
});

test('runnable drain inventory still prevents producers from growing the queue unchecked', async () => {
  let drainWhere: Prisma.AtsIngestionBatchWhereInput | undefined;
  let countWhere: Prisma.AtsIngestionBatchWhereInput | undefined;
  const transaction = { $executeRaw: async () => 0,
    atsIngestionBatch: {
      findFirst: async (args: { where: Prisma.AtsIngestionBatchWhereInput }) => {
        drainWhere = args.where; return { id: 'retrying-drain' };
      },
      count: async (args: { where: Prisma.AtsIngestionBatchWhereInput }) => { countWhere = args.where; return 1; },
    },
  } as unknown as Parameters<typeof withAtsListingCapacity>[0];
  const claim = await withAtsListingCapacity(transaction, now, 1, async () => { throw new Error('Capacity is occupied'); });
  assert.equal(claim, null);
  assert.ok(JSON.stringify(drainWhere).includes('nextAcquireAt'));
  assert.ok(JSON.stringify(drainWhere).includes('acquisitionLeaseExpiresAt'));
  assert.deepEqual(countWhere?.acquisitionLeaseExpiresAt, { gt: now });
  assert.deepEqual(countWhere?.acquisitionClaimToken, { not: null });
});

test('expired producer leases do not reserve capacity forever', async () => {
  const transaction = { $executeRaw: async () => 0,
    atsIngestionBatch: { findFirst: async () => ({ id: 'drain' }), count: async () => 0 },
  } as unknown as Parameters<typeof withAtsListingCapacity>[0];
  assert.equal(await withAtsListingCapacity(transaction, now, 1, async () => 'replacement'), 'replacement');
});

test('oldest eligible work is retained within its service class with retry guards intact', async () => {
  const guards = { OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: now } }] };
  let seen: unknown;
  const client = { atsIngestionBatch: { findFirst: async (args: { where: unknown }) => {
    seen = args.where; return { id: 'oldest', acquisitionPhase: 'enrichment', lastServedAt: null };
  } } } as unknown as Parameters<typeof findAtsContinuationCandidate>[0];
  assert.equal((await findAtsContinuationCandidate(client, guards, [], now))?.id, 'oldest');
  assert.equal(seen, guards);
});

test('long-waiting work cannot be bypassed by the finishing preference', async () => {
  const client = { atsIngestionBatch: {
    findFirst: async () => ({ id: 'long-waiting', acquisitionPhase: 'listing', lastServedAt: new Date(+now - 86400000) }),
    findMany: async () => { throw Error('The finishing preference cannot bypass this wait'); },
  } } as unknown as Parameters<typeof findAtsContinuationCandidate>[0];
  assert.equal((await findAtsContinuationCandidate(client, { acquisitionPhase: 'listing' }, [], now, true))?.id, 'long-waiting');
});


test('coverage and continuation together cannot exceed two listing leases across eight workers', async () => {
  let lockTail = Promise.resolve();
  let liveListings = 0;
  const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    let unlock = () => {};
    const transaction = {
      $executeRaw: async () => {
        const previous = lockTail;
        lockTail = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        return 0;
      },
      atsIngestionBatch: { findFirst: async () => ({ id: 'drain' }), count: async () => liveListings },
    } as unknown as Parameters<typeof withAtsListingCapacity>[0];
    try {
      return await withAtsListingCapacity(transaction, now, ATS_COHORT_PRESSURE_LISTING_CONCURRENCY, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        liveListings++;
        return index;
      });
    } finally { unlock(); }
  }));
  assert.equal(results.filter(result => result !== null).length, 2);
  assert.equal(liveListings, 2);
});

test('catalogue selection preserves provider, retry and lease conditions within a class', async () => {
  const guards: Prisma.AtsIngestionBatchWhereInput = {
    acquisitionPhase: 'listing', OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: now } }],
    AND: [{ OR: [{ acquisitionClaimToken: null }, { acquisitionLeaseExpiresAt: { lte: now } }] }],
  };
  const client = { atsIngestionBatch: { findFirst: async (args: { where: unknown }) => {
    assert.equal(args.where, guards);
    return { id: 'saved', acquisitionPhase: 'listing', lastServedAt: null };
  } } } as unknown as Parameters<typeof findAtsContinuationCandidate>[0];
  assert.equal((await findAtsContinuationCandidate(client, guards, [], now))?.id, 'saved');
});


test('continuations cannot occupy the producer slot reserved for fresh cohort coverage', async () => {
  let listings = 0;
  const transaction = { $executeRaw: async () => 0,
    atsIngestionBatch: { findFirst: async () => ({ id: 'drain' }), count: async () => listings },
  } as unknown as Parameters<typeof withAtsListingCapacity>[0];
  const claim = async () => { listings++; return 'claimed'; };
  assert.equal(await withAtsListingCapacity(transaction, now, 1, claim), 'claimed');
  assert.equal(await withAtsListingCapacity(transaction, now, 1, claim), null);
  assert.equal(await withAtsListingCapacity(transaction, now, ATS_COHORT_PRESSURE_LISTING_CONCURRENCY, claim), 'claimed');
  assert.equal(listings, 2);
  assert.equal(await withAtsListingCapacity(transaction, now, ATS_COHORT_PRESSURE_LISTING_CONCURRENCY, claim), null);
});

test('pressure finishes the nearest healthy saved catalogue while retaining retry and lease eligibility', async () => {
  const guards: Prisma.AtsIngestionBatchWhereInput = {
    acquisitionPhase: 'listing', OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: now } }],
    AND: [{ acquisitionClaimToken: null }],
  };
  const client = { atsIngestionBatch: {
    findFirst: async () => ({ id: 'oldest-recent', acquisitionPhase: 'listing', lastServedAt: now }),
    findMany: async (args: { where: Prisma.AtsIngestionBatchWhereInput; take: number }) => {
      assert.deepEqual(args.where.AND, [guards,
        { acquisitionPhase: 'listing', listingOffset: { gt: 0 }, latestObservedTotal: { gt: 0 }, lastError: null }]);
      assert.equal(args.take, 64);
      return [
        { id: 'large', acquisitionPhase: 'listing', listingOffset: 5000, latestObservedTotal: 10000 },
        { id: 'nearly-finished', acquisitionPhase: 'listing', listingOffset: 9000, latestObservedTotal: 9050 },
        { id: 'drifting-total', acquisitionPhase: 'listing', listingOffset: 500, latestObservedTotal: 450 },
      ];
    },
  } } as unknown as Parameters<typeof findAtsContinuationCandidate>[0];
  assert.equal((await findAtsContinuationCandidate(client, guards, [], now, true))?.id, 'nearly-finished');
});

test('pressure falls back to ordinary fairness when no healthy known-total catalogue exists', async () => {
  const client = { atsIngestionBatch: {
    findMany: async () => [], findFirst: async () => ({ id: 'fair-fallback', acquisitionPhase: 'listing', lastServedAt: now }),
  } } as unknown as Parameters<typeof findAtsContinuationCandidate>[0];
  assert.equal((await findAtsContinuationCandidate(client, { acquisitionPhase: 'listing' }, [], now, true))?.id, 'fair-fallback');
});
