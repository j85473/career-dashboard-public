/** Exercise production planning, admission and leases against an empty local database. */
import assert from 'node:assert/strict';
import { prisma } from '../../src/lib/prisma';
import { Prisma } from '../../src/lib/prismaClient';
import { atsEvidenceRefreshBatchesSql } from '../../src/lib/atsEvidenceRefresh';
import { atsV2ShadowLanePlan, claimNextAtsV2Coverage, selectNextAtsV2CoverageBoard } from '../../src/lib/atsAcquisitionDispatcherV2';
import { admitAtsV2Board } from '../../src/lib/atsAcquisitionLedger';
import { ATS_ACQUISITION_WRITER_VERSION } from '../../src/lib/atsAcquisitionCompatibility';
import { apiRotationDayFor } from '../../src/lib/atsRotation';
import { readAtsDistributedTelemetry } from '../../src/lib/atsDistributedTelemetry';

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.pathname.startsWith('/career_capacity_fixtures_'));
  assert.equal(await prisma.atsIngestionBatch.count(), 0);
  const now = new Date(), past = new Date(+now - 8 * 86400000), future = new Date(+now + 86400000);
  const key = { slug: 'overdue-fixture', platform: 'ukg' };
  const boardWhere = { slug_platform: key };
  await prisma.atsAcquisitionRuntimeGate.create({ data: { id: 'global', v2AuthorityActivatedAt: past, activatedLedgerVersion: 2,
    minimumWriterVersion: ATS_ACQUISITION_WRITER_VERSION, compatibilityWriterVersion: ATS_ACQUISITION_WRITER_VERSION } });
  await prisma.atsCompany.create({ data: { ...key, acquisitionEngine: 'v2', checkDay: apiRotationDayFor(now),
    nextCheckDate: past, lastSynchronizedAt: past } });
  const original = await prisma.atsIngestionBatch.create({ data: { ...key, createdAt: past, writerMode: 'v2', status: 'synchronized',
    acquisitionPhase: 'synchronized', listingCompletedAt: past, synchronizedAt: past, activeLedgerGeneration: 1,
    rawObservationCount: 2, canonicalOccurrenceCount: 2, terminalItemCount: 2, sealedItemCount: 2, publishedItemCount: 2 } });
  const createSegment = (ordinal: number) => ({ batchId: original.id, ledgerGeneration: 1, segmentSize: 1,
    segmentOrdinal: ordinal, firstOrdinal: ordinal, lastOrdinal: ordinal, itemCount: 1, enrichmentVersion: 1,
    manifestHash: String(ordinal).repeat(64), status: 'published', publishedAt: past });
  const held = await prisma.atsIngestionSegment.create({ data: { ...createSegment(0), nextProcessAt: future,
    retryCode: 'employer_unverified', retryScope: 'posting', holdReason: 'Saved employer evidence' } });
  const second = await prisma.atsIngestionSegment.create({ data: { ...createSegment(1), nextProcessAt: past,
    holdReason: 'ukg downloaded work awaits a verified employer' } });
  const job = await prisma.job.create({ data: { title: 'Territory Manager', company: 'Verified Employer',
    postedAt: past, fitScore: 89, aimFitScore: 94, status: 'interviewing' } });
  const readOld = () => prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: original.id },
    include: { segments: { orderBy: { segmentOrdinal: 'asc' } } } });
  const snapshot = await readOld();
  const eligible = async () => (await prisma.$queryRaw<Array<{ id: string }>>(atsEvidenceRefreshBatchesSql())).map(row => row.id);
  for (const zone of ['UTC', 'America/Chicago']) {
    const rows = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
      return tx.$queryRaw<Array<{ id: string }>>(atsEvidenceRefreshBatchesSql(Prisma.sql`batch.id=${original.id}`));
    });
    assert.deepEqual(rows.map(row => row.id), [original.id]);
  }
  const holdWhere = { id: held.id };
  for (const change of [
    { retryCode: 'network_failure' }, { retryScope: 'provider' }, { status: 'processing', leaseToken: 'live', leaseExpiresAt: future },
    { retryCode: null, holdReason: 'unclassified failure' }, { status: 'sealed' }, { ledgerGeneration: 2 },
  ]) {
    await prisma.atsIngestionSegment.update({ where: holdWhere, data: change });
    assert.deepEqual(await eligible(), []);
    assert.equal(await admitAtsV2Board({ ...key, now }), null);
    await prisma.atsIngestionSegment.update({ where: holdWhere, data: { retryCode: held.retryCode, retryScope: held.retryScope,
      holdReason: held.holdReason, status: held.status, leaseToken: null, leaseExpiresAt: null, ledgerGeneration: 1, updatedAt: held.updatedAt } });
  }
  for (const change of [{ firstCollectionState: 'admitted' }, { firstCollectionHoldReason: 'size review' }, { status: 'parked' }]) {
    await prisma.atsCompany.update({ where: boardWhere, data: change });
    assert.deepEqual(await eligible(), []);
    assert.equal(await admitAtsV2Board({ ...key, now }), null);
    await prisma.atsCompany.update({ where: boardWhere, data: { firstCollectionState: 'established', firstCollectionHoldReason: null, status: 'active' } });
  }
  await prisma.atsCompany.update({ where: boardWhere, data: { nextCheckDate: future } });
  assert.equal((await atsV2ShadowLanePlan(now)).coverageEligible, 0);
  assert.equal(await admitAtsV2Board({ ...key, now }), null);
  await prisma.atsCompany.update({ where: boardWhere, data: { nextCheckDate: past } });
  assert.equal(await selectNextAtsV2CoverageBoard(now, false, ['ukg']), null);
  await prisma.providerCircuit.create({ data: { provider: 'ATS-ukg', state: 'open', openUntil: future, lastError: 'HTTP 429' } });
  assert.equal((await atsV2ShadowLanePlan(now)).coverageEligible, 0);
  assert.equal(await admitAtsV2Board({ ...key, now }), null);
  await prisma.providerCircuit.update({ where: { provider: 'ATS-ukg' }, data: { state: 'closed', openUntil: null } });

  assert.equal((await atsV2ShadowLanePlan(now, true)).coverageEligible, 1);
  assert.equal((await selectNextAtsV2CoverageBoard(now, true))?.slug, key.slug);
  const telemetry = await readAtsDistributedTelemetry();
  assert.equal(telemetry.cohortReadyNow, 1);
  assert.equal(telemetry.globalReadyNow, 1);
  await prisma.atsCompany.update({ where: boardWhere, data: { checkDay: (apiRotationDayFor(now) + 1) % 4 } });
  assert.equal((await atsV2ShadowLanePlan(now, true)).coverageEligible, 0);
  assert.equal(await selectNextAtsV2CoverageBoard(now, true), null);
  const plan = await atsV2ShadowLanePlan(now);
  assert.equal(plan.coverageEligible, 1);
  assert.deepEqual(plan.evidenceRefreshIds, [original.id]);
  await prisma.atsIngestionSegment.update({ where: holdWhere, data: { retryCode: 'network_failure' } });
  assert.equal(await claimNextAtsV2Coverage(now, [], plan.evidenceRefreshIds), null,
    'a previously eligible board must still qualify when a worker claims it');
  await prisma.atsIngestionSegment.update({ where: holdWhere, data: { retryCode: held.retryCode, updatedAt: held.updatedAt } });
  const claims = await Promise.all(Array.from({ length: 4 }, () => claimNextAtsV2Coverage(now, [], plan.evidenceRefreshIds)));
  const claimed = claims.filter(claim => claim !== null);
  assert.equal(claimed.length, 1);
  assert.notEqual(claimed[0].batchId, original.id);
  assert.equal((await atsV2ShadowLanePlan(now)).coverageEligible, 0);
  assert.deepEqual(await readOld(), snapshot);
  assert.equal(await prisma.atsEndpointSweepReceipt.count({ where: { ...key } }), 1);
  assert.equal(await admitAtsV2Board({ ...key, now }), null);

  // Two fully downloaded collections both waiting for evidence must still
  // block a third. Give the new fixture a matching, independently held item.
  const repeat = claimed[0].batchId;
  await prisma.atsIngestionBatch.update({ where: { id: repeat }, data: { status: 'synchronized', acquisitionPhase: 'synchronized',
    listingCompletedAt: now, synchronizedAt: now, canonicalOccurrenceCount: 1, terminalItemCount: 1,
    sealedItemCount: 1, publishedItemCount: 1, acquisitionClaimToken: null, acquisitionLeaseExpiresAt: null } });
  await prisma.atsIngestionSegment.create({ data: { ...createSegment(0), batchId: repeat,
    retryCode: 'location_unverified', retryScope: 'posting', nextProcessAt: future } });
  assert.deepEqual(await eligible(), []);
  assert.equal(await admitAtsV2Board({ ...key, now }), null);
  assert.deepEqual(await readOld(), snapshot);
  assert.deepEqual(await prisma.job.findUnique({ where: { id: job.id } }), job);

  // Ordinary recovery can clear the older collection and restore another turn.
  await prisma.atsIngestionSegment.updateMany({ where: { id: { in: [held.id, second.id] } },
    data: { status: 'processed', processingOffset: 1, processedAt: now, nextProcessAt: null } });
  await prisma.atsIngestionBatch.update({ where: { id: original.id }, data: { status: 'processed', processedAt: now } });
  assert.deepEqual(await eligible(), [repeat]);
  console.log('Verified bounded refresh, first-collection and provider controls, both service cohorts, concurrent admission, retained evidence and scores.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
