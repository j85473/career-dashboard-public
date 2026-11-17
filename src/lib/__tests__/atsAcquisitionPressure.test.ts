import { ATS_ACQUISITION_WRITER_VERSION } from '../atsAcquisitionCompatibility';
import { prisma } from '../prisma';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '../prismaClient';
import {
  ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK, ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK,
  ATS_V2_MAX_UNFINISHED_LISTINGS, evaluateAtsAcquisitionPressure,
} from '../atsAcquisitionPressure';
import { admitAtsV2Board, atsV2StagingSnapshot, findAtsContinuationCandidate } from '../atsAcquisitionLedger';
import { planAtsV2RuntimeCapacity } from '../atsAcquisitionDispatcherV2';

test('admission stops before hard capacity and counts unfinished listings even with few records', () => {
  const idle = { items: 0, bytes: BigInt(0), unfinishedListings: 0 };
  assert.equal(evaluateAtsAcquisitionPressure(idle).admissionBlocked, false);
  const early = evaluateAtsAcquisitionPressure({ ...idle, items: ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK / 2 });
  assert.equal(early.admissionReason, 'staging');
  assert.equal(early.blocked, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...idle, bytes: ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK / BigInt(2) }).admissionBlocked, true);
  const unfinished = evaluateAtsAcquisitionPressure({ ...idle, unfinishedListings: ATS_V2_MAX_UNFINISHED_LISTINGS });
  assert.equal(unfinished.admissionReason, 'unfinished_listings');
  assert.equal(unfinished.blocked, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...idle, items: ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK }).blocked, true);
});

test('eight simultaneous admissions cannot exceed the unfinished listing allowance', async () => {
  const original = prisma.$transaction;
  let active = ATS_V2_MAX_UNFINISHED_LISTINGS - 1;
  let tail = Promise.resolve();
  let admissions = 0;
  prisma.$transaction = (async (run: (client: unknown) => Promise<unknown>, options: { isolationLevel: string }) => {
    assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.ReadCommitted);
    let unlock = () => {};
    const client = {
      $executeRaw: async (parts: TemplateStringsArray) => {
        if (parts.join('').includes('pg_advisory_xact_lock')) {
          const previous = tail;
          tail = new Promise<void>((resolve) => { unlock = resolve; });
          await previous;
        }
      },
      $queryRaw: async () => [{ items: 0, bytes: 0, unfinishedListings: active }],
      atsCompany: { findUnique: async () => ({ acquisitionEngine: 'v2', nextCheckDate: new Date(0), status: 'active', checkDay: 5 }) },
      atsAcquisitionRuntimeGate: { findUnique: async () => ({ admissionState: 'open', v2AuthorityActivatedAt: new Date(0), activatedLedgerVersion: 2, minimumWriterVersion: ATS_ACQUISITION_WRITER_VERSION, compatibilityWriterVersion: ATS_ACQUISITION_WRITER_VERSION }) },
      atsIngestionBatch: {
        findFirst: async () => null,
        create: async () => { await Promise.resolve(); active++; admissions++; },
      },
      atsEndpointSweepReceipt: { create: async () => {} },
      atsAcquisitionWorkReceipt: { create: async () => {} },
    };
    try { return await run(client); } finally { unlock(); }
  }) as typeof prisma.$transaction;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => admitAtsV2Board({ slug: `board-${i}`, platform: 'workday' })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(admissions, 1);
    assert.equal(active, ATS_V2_MAX_UNFINISHED_LISTINGS);
  } finally { prisma.$transaction = original; }
});

test('pressure snapshot does not let delayed retries consume active admission slots', async () => {
  let sql = '';
  const client = { $queryRaw: async (query: Prisma.Sql) => {
    sql = query.sql;
    return [{ items: 640, bytes: 1000, unfinishedListings: 32 }];
  } } as unknown as Parameters<typeof atsV2StagingSnapshot>[0];
  const pressure = await atsV2StagingSnapshot(client, new Date('2026-10-09T19:00:00Z'));
  assert.equal(pressure.admissionBlocked, true);
  assert.match(sql, /"nextAcquireAt" IS NULL\s+OR batch\."nextAcquireAt" <=/);
  assert.match(sql, /"acquisitionLeaseExpiresAt" >/);
});

test('listing demand alone does not saturate downstream capacity', () => {
  const shadow = { totalSlots: 8, coverageSlots: 7, continuationSlots: 1, requiredByNow: 100,
    coverageDebt: 100, projectedContacts: 100, reason: 'fixture', coverageEligible: 10000,
    continuationEligible: 100, drainEligible: 0 };
  const full = evaluateAtsAcquisitionPressure({ items: 640, bytes: BigInt(1000), unfinishedListings: 32 });
  const held = planAtsV2RuntimeCapacity(shadow, full, 8);
  assert.equal(held.coverageSlots, 0); assert.equal(held.reason, 'finishing_listings');
  const open = evaluateAtsAcquisitionPressure({ items: 640, bytes: BigInt(1000), unfinishedListings: 8 });
  const listingOnly = planAtsV2RuntimeCapacity(shadow, open, 8);
  assert.notEqual(listingOnly.reason, 'draining'); assert.equal(listingOnly.listingConcurrencyLimit, undefined);
  const busy = planAtsV2RuntimeCapacity({ ...shadow, drainEligible: 100 }, open, 8);
  assert.equal(busy.coverageSlots, 1); assert.equal(busy.listingConcurrencyLimit, 1);
});


test('saved catalogue selection retains retry and lease guards', async () => {
  const guard = { acquisitionPhase: 'listing', OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: new Date(0) } }] };
  const client = { atsIngestionBatch: { findFirst: async (input: { where: unknown }) => {
    assert.equal(input.where, guard);
    return { id: 'partially-downloaded', acquisitionPhase: 'listing', lastServedAt: null };
  } } } as unknown as Parameters<typeof findAtsContinuationCandidate>[0];
  assert.equal((await findAtsContinuationCandidate(client, guard, [], new Date()))?.id, 'partially-downloaded');
});


test('today has a separate bounded allowance without bypassing volume limits', () => {
  const oldBacklog = { items: 25_000, bytes: BigInt(1_000), unfinishedListings: 1_002, cohortUnfinishedListings: 0 };
  const pressure = evaluateAtsAcquisitionPressure(oldBacklog);
  assert.equal(pressure.admissionBlocked, true);
  assert.equal(pressure.cohortAdmissionAllowed, true);
  assert.equal(evaluateAtsAcquisitionPressure({ ...oldBacklog, cohortUnfinishedListings: 32 }).cohortAdmissionAllowed, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...oldBacklog, items: ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK / 2 }).cohortAdmissionAllowed, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...oldBacklog, bytes: ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK / BigInt(2) }).cohortAdmissionAllowed, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...oldBacklog, items: ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK }).cohortAdmissionAllowed, false);
});

test('old backlog leaves a bounded current-cohort opportunity without bypassing volume limits', () => {
  const shadow = { totalSlots: 8, coverageSlots: 7, continuationSlots: 1, requiredByNow: 100,
    coverageDebt: 100, projectedContacts: 100, reason: 'fixture', coverageEligible: 10000,
    continuationEligible: 1000, drainEligible: 8 };
  const pressure = (cohortUnfinishedListings: number, items = 25000) => evaluateAtsAcquisitionPressure({
    items, bytes: BigInt(1000), unfinishedListings: 1002, cohortUnfinishedListings,
  });
  const balanced = planAtsV2RuntimeCapacity(shadow, pressure(0), 8);
  assert.equal(balanced.coverageSlots, 1); assert.equal(balanced.reason, 'cohort_balanced');
  assert.equal(balanced.listingConcurrencyLimit, 1);
  const full = planAtsV2RuntimeCapacity(shadow, pressure(32), 8);
  assert.equal(full.coverageSlots, 0); assert.equal(full.listingConcurrencyLimit, 2);
  const volumeHeld = planAtsV2RuntimeCapacity(shadow, pressure(0, ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK / 2), 8);
  assert.equal(volumeHeld.coverageSlots, 0); assert.equal(volumeHeld.listingConcurrencyLimit, 1);
});
