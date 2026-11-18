/** Run only on a disposable local database with the current Prisma schema. */
import assert from 'node:assert/strict';
import { prisma } from '../../src/lib/prisma';
import { readAtsRetainedInventory } from '../../src/lib/atsRetainedInventory';
import { readAtsDistributedTelemetry, formatAtsDistributedTelemetry } from '../../src/lib/atsDistributedTelemetry';
import { readAtsQueueTelemetry } from '../../src/lib/atsQueueTelemetry';

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/ats_retained_inventory_test_clean');
  const now = new Date(), past = new Date(+now - 3600_000), future = new Date(+now + 3600_000);
  const boards = [
    { slug: 'unattempted', status: 'parked', nextCheckDate: past },
    { slug: 'due', status: 'parked', nextCheckDate: past, lastAttemptedAt: past },
    { slug: 'scheduled', status: 'blacklisted', nextCheckDate: future, lastAttemptedAt: past },
    { slug: 'legacy', status: 'blacklisted', nextCheckDate: past, lastCheckedAt: past },
    { slug: 'active', status: 'active', nextCheckDate: past },
    { slug: 'excluded', status: 'excluded', nextCheckDate: past },
  ];
  await prisma.atsCompany.createMany({ data: boards.map(b => ({ ...b, platform: 'cornerstone', checkDay: 0 })) });
  await prisma.atsCompany.create({ data: { slug: 'gusto-held', platform: 'gusto', checkDay: 0, status: 'parked' } });
  await prisma.atsAcquisitionRuntimeGate.create({ data: { id: 'global', admissionState: 'open' } });
  const base = { platform: 'cornerstone', writerMode: 'v2', status: 'partial', acquisitionPhase: 'enrichment' };
  const working = await prisma.atsIngestionBatch.create({ data: { ...base, slug: 'unattempted', rawObservationCount: 40,
    compactedOccurrenceCount: 5, publishedItemCount: 5, nextAcquireAt: future,
    acquisitionClaimToken: 'live', acquisitionLeaseExpiresAt: future } });
  await prisma.atsIngestionBatch.create({ data: { ...base, slug: 'due', rawObservationCount: 60,
    nextAcquireAt: future, acquisitionClaimToken: 'expired', acquisitionLeaseExpiresAt: past } });
  await prisma.atsIngestionBatch.create({ data: { ...base, slug: 'scheduled', rawObservationCount: 10, nextAcquireAt: past } });
  await prisma.atsIngestionBatch.create({ data: { ...base, slug: 'legacy', rawObservationCount: 5, publishedItemCount: 10 } });
  await prisma.atsIngestionBatch.create({ data: { ...base, slug: 'active', status: 'processed', rawObservationCount: 1000 } });
  await prisma.atsIngestionBatch.create({ data: { ...base, slug: 'gusto-held', platform: 'gusto', rawObservationCount: 1000 } });
  for (const [index, retryCode, nextProcessAt] of [
    [0, null, past], [1, null, future], [2, 'employer_unverified', past], [3, 'location_unverified', future],
  ] as const) await prisma.atsIngestionSegment.create({ data: { batchId: working.id, ledgerGeneration: 0,
    segmentOrdinal: index, segmentSize: 25, firstOrdinal: index * 25, lastOrdinal: index * 25 + 24, itemCount: 25,
    manifestHash: `fixture-${index}`, enrichmentVersion: 1, status: 'published', retryCode, nextProcessAt } });
  const job = await prisma.job.create({ data: { title: 'Preserved interview', company: 'Fixture', postedAt: now,
    status: 'interviewing', fitScore: 87, aimFitScore: 93 } });
  const before = JSON.stringify(await prisma.atsCompany.findMany({ orderBy: { slug: 'asc' } }));
  for (const zone of ['UTC', 'America/Chicago']) {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
      const result = await readAtsRetainedInventory(tx, now);
      assert.deepEqual(result.boards, { total: 4, withoutRecordedAttempt: 1, retryDue: 2, retryScheduled: 1 });
      assert.deepEqual(result.downloads, { total: 100, working: 30, scheduledRetry: 60, other: 10 });
    });
  }
  const telemetry = await readAtsDistributedTelemetry();
  assert.equal(telemetry.stagingItems, 100);
  assert.equal(telemetry.stagingRetryItems, 60);
  assert.equal(telemetry.stagingAdmissionItems, 40);
  assert.match(formatAtsDistributedTelemetry(telemetry), /Retryitems 60/);
  const queues = await readAtsQueueTelemetry();
  assert.equal(queues.persistenceDue, 25);
  assert.equal(queues.persistenceHeld, 25);
  assert.equal(queues.persistenceEvidenceHeld, 50);
  assert.equal(queues.retained?.downloads.total, 100);
  assert.equal(JSON.stringify(await prisma.atsCompany.findMany({ orderBy: { slug: 'asc' } })), before);
  assert.deepEqual(await prisma.job.findUnique({ where: { id: job.id } }), job);
  console.log('Retained inventories reconcile in UTC and Chicago; evidence holds stay separate; boards and scores preserved.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
