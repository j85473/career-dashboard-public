/** Run only against a freshly created local fixture database:
 * DATABASE_URL=postgresql://capacity_test@127.0.0.1:55447/career_capacity_fixtures2
 * ATS_ACQUISITION_CONCURRENCY=8 node --import tsx tests/integration/atsCapacityScheduling.ts
 * Apply the current schema to that empty database first. No production access.
 */
import assert from 'node:assert/strict';
import { prisma } from '../../src/lib/prisma';
import { reserveAtsServiceTurn, finishAtsServiceTurn, readAtsServiceState } from '../../src/lib/atsServiceScheduling';
import { reservePublicCrawlTurn, heartbeatPublicCrawlTurn, releasePublicCrawlTurn } from '../../src/lib/publicCrawlCapacity';
import { atsV2ShadowLanePlan, atsV2RuntimeLanePlan, selectNextAtsV2CoverageBoard } from '../../src/lib/atsAcquisitionDispatcherV2';
import { atsContinuationEligibilityWhere } from '../../src/lib/atsSchedulingEligibility';
import { withAtsListingCapacity } from '../../src/lib/atsContinuationCapacity';
import { claimNextAtsV2Continuation, finishAtsV2Claim, publishReadyAtsV2Segments, atsV2PersistenceCapacityBacklog, admitAtsV2Board } from '../../src/lib/atsAcquisitionLedger';
import { apiRotationDayFor } from '../../src/lib/atsRotation';
import { readCrawlQueueHeads } from '../../src/lib/atsCrawlingSchedule';
import { reserveCrawlBoardService } from '../../src/lib/crawlTimeBudget';

async function reviewedCoverageRegression(now: Date) {
  const day = apiRotationDayFor(now), future = new Date(+now + 86400000);
  const boards = [
    { platform: 'clearcompany', slug: '11111111-1111-1111-1111-111111111111', jobsFound: 251 },
    { platform: 'symphony', slug: 'hgv', jobsFound: 300 },
  ];
  await prisma.atsFirstCollectionPolicy.create({ data: { id: 'new-providers', mode: 'capacity', maxUnfinished: 32, healthObservedAt: now } });
  await prisma.atsFirstCollectionPolicy.create({ data: { id: 'reviewed-oversized', mode: 'capacity',
    maxUnfinished: 1, maxCatalogueJobs: 5000, pilotBoards: boards.map(b => `${b.platform}::${b.slug}`) } });
  for (const board of boards) await prisma.atsCompany.create({ data: { ...board, checkDay: day,
    acquisitionEngine: 'v2', firstCollectionState: 'ready', nextCheckDate: new Date(+now - 86400000) } });
  const first = { slug_platform: { slug: boards[0].slug, platform: boards[0].platform } };
  const expectSymphony = async (cohortOnly = false) => {
    assert.equal((await selectNextAtsV2CoverageBoard(now, cohortOnly))?.slug, 'hgv');
    assert.equal((await atsV2ShadowLanePlan(now, cohortOnly)).coverageEligible, 1,
      'planning and dispatch must admit the same eligible reviewed board');
  };
  await prisma.providerCircuit.create({ data: { provider: 'ATS-clearcompany', state: 'open', openUntil: future } });
  await expectSymphony();
  await prisma.providerCircuit.update({ where: { provider: 'ATS-clearcompany' }, data: { openUntil: new Date(+now - 1) } });
  await prisma.atsCompany.update({ where: first, data: { firstCollectionHoldReason: 'Explicit review hold' } });
  await expectSymphony();
  await prisma.atsCompany.update({ where: first, data: { firstCollectionHoldReason: null, nextCheckDate: future } });
  await expectSymphony();
  await prisma.atsCompany.update({ where: first, data: { nextCheckDate: now } });
  const retained = await prisma.atsIngestionBatch.create({ data: { slug: boards[0].slug, platform: boards[0].platform,
    writerMode: 'v2', status: 'reset_draining', acquisitionPhase: 'listing' } });
  await expectSymphony();
  await prisma.atsIngestionBatch.update({ where: { id: retained.id }, data: { status: 'processed' } });
  await prisma.atsCompany.update({ where: first, data: { checkDay: (day + 1) % 4 } });
  await expectSymphony(true);
  // Remove these fixture boards from later demand counts without deleting evidence.
  await prisma.atsCompany.updateMany({ where: { OR: boards.map(({ platform, slug }) => ({ platform, slug })) }, data: { nextCheckDate: future } });
}

async function publicQueueRegression(now: Date) {
  const future = new Date(+now + 86400000), past = new Date(+now - 86400000);
  const task = await prisma.ingestionTask.create({ data: { taskKey: 'queue-fixture', source: 'ATS-icims',
    geoLane: 'source_posted_location', ingestionMode: 'public-board', nextRunAt: past } });
  for (const queue of ['first', 'refresh', 'retry']) await prisma.atsCompany.create({ data: {
    slug: `queue-${queue}`, platform: 'icims', checkDay: 0, nextCheckDate: queue === 'retry' ? future : past,
    lastSynchronizedAt: queue === 'first' ? null : past, failCount: queue === 'retry' ? 1 : 0,
  } });
  const initial = await readCrawlQueueHeads(['icims']);
  assert.deepEqual(initial.map(h => h.queue).sort(), ['first', 'refresh'], 'retain both queues within one provider');
  const first = (await reserveCrawlBoardService('queue-fixture', initial, { now }))!;
  assert.equal(first.board.queue, 'first');
  await finishAtsServiceTurn(first.serviceTurn, true, new Date(+now + 10000));
  await prisma.atsCompany.update({ where: { slug_platform: { slug: 'queue-refresh', platform: 'icims' } }, data: { nextCheckDate: future } });
  await prisma.atsCompany.update({ where: { slug_platform: { slug: 'queue-retry', platform: 'icims' } }, data: { nextCheckDate: past } });
  const ready = await readCrawlQueueHeads(['icims']);
  assert.deepEqual(ready.map(h => h.queue).sort(), ['first', 'retry']);
  const second = (await reserveCrawlBoardService('queue-fixture', ready, { now: new Date(+now + 10001) }))!;
  assert.equal(second.board.queue, 'first');
  assert.equal(second.serviceTurn.key, second.board.queue, 'no preview/reservation mismatch on queue return');
  await finishAtsServiceTurn(second.serviceTurn, false, new Date(+now + 10002));
  // A provider claimed after the snapshot must disappear on the next selection.
  await prisma.ingestionTask.update({ where: { id: task.id }, data: { leaseToken: 'queue-fixture-live', leaseExpiresAt: future } });
  assert.equal((await readCrawlQueueHeads(['icims'])).length, 0);
  assert.equal(Object.keys((await readAtsServiceState('queue-fixture')).pending).length, 0);
}

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55447');
  assert.equal(url.username, 'capacity_test'); assert.ok(url.pathname.startsWith('/career_capacity_fixtures'));
  const now = new Date(), day = apiRotationDayFor(now);
  await prisma.atsAcquisitionRuntimeGate.create({ data: { id: 'global', admissionState: 'open', globalSlotLimit: 8, localSlotReserve: 0 } });
  const job = await prisma.job.create({ data: { title: 'Preserved candidate job', company: 'Fixture employer',
    postedAt: now, status: 'interviewing', fitScore: 87, aimFitScore: 93, description: 'Original description' } });
  const protectedBefore = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
  await reviewedCoverageRegression(now);
  await publicQueueRegression(now);

  // Three independent collector groups race for the same unchanged allowance.
  const reservations = await Promise.all(Array.from({ length: 12 }, (_, n) => reservePublicCrawlTurn(`collector-${n}`, now)));
  const granted = reservations.filter((r): r is NonNullable<typeof r> => r !== null);
  assert.equal(granted.length, 2);
  assert.equal((await prisma.atsPublicCapacityLease.aggregate({ where: { leaseExpiresAt: { gt: now } }, _sum: { jobs: true } }))._sum.jobs, 100);
  const waiting = await prisma.atsPublicCapacityLease.findFirstOrThrow({ where: { requestedAt: { not: null } }, orderBy: [{ requestedAt: 'asc' }, { resource: 'asc' }] });
  await releasePublicCrawlTurn(granted[0]);
  assert.equal(await reservePublicCrawlTurn(granted[0].resource, new Date(+now + 1)), null, 'a fast collector cannot jump ahead of waiting groups');
  const olderWaitingTurn = await reservePublicCrawlTurn(waiting.resource, new Date(+now + 1));
  assert.ok(olderWaitingTurn);
  await releasePublicCrawlTurn(olderWaitingTurn);
  await prisma.atsPublicCapacityLease.deleteMany({ where: { requestedAt: { not: null } } });
  const stale = granted[1];
  await prisma.atsPublicCapacityLease.update({ where: { resource: stale.resource }, data: { leaseExpiresAt: new Date(+now - 1) } });
  const replacement = (await reservePublicCrawlTurn(stale.resource, now))!;
  assert.ok(replacement); assert.notEqual(replacement.token, stale.token);
  assert.equal(await heartbeatPublicCrawlTurn(stale, now), false);
  await releasePublicCrawlTurn(stale);
  assert.equal(await heartbeatPublicCrawlTurn(replacement, now), true);
  await releasePublicCrawlTurn(replacement);

  await prisma.atsCompany.create({ data: { slug: 'publication-race', platform: 'workday', acquisitionEngine: 'v2',
    checkDay: day, nextCheckDate: new Date(+now + 86400000) } });
  const publication = await prisma.atsIngestionBatch.create({ data: { slug: 'publication-race', platform: 'workday',
    writerMode: 'v2', status: 'synchronized', acquisitionPhase: 'synchronized', activeLedgerGeneration: 1 } });
  await prisma.atsIngestionSegment.createMany({ data: Array.from({ length: 84 }, (_, n) => ({
    batchId: publication.id, ledgerGeneration: 1, segmentOrdinal: n, segmentSize: 25, firstOrdinal: n * 25,
    lastOrdinal: n * 25 + 24, itemCount: 25, manifestHash: 'a'.repeat(64), enrichmentVersion: 1,
  })) });
  const servedCollectors = new Set<string>();
  for (let n = 0; n < 10; n++) {
    const at = new Date(+now + n * 1000);
    const [, ...publicClaims] = await Promise.all([
      publishReadyAtsV2Segments({ highWatermark: 2000, lowWatermark: 1000, maxSegments: 10, now: at }),
      ...['race-adp', 'race-http', 'race-browser'].map(resource => reservePublicCrawlTurn(resource, at)),
    ]);
    const active = await prisma.atsPublicCapacityLease.aggregate({ where: { leaseExpiresAt: { gt: at } }, _sum: { jobs: true } });
    assert.ok(await atsV2PersistenceCapacityBacklog(prisma, at) + (active._sum.jobs || 0) <= 2000);
    for (const turn of publicClaims) if (turn) { servedCollectors.add(turn.resource); await releasePublicCrawlTurn(turn); }
  }
  assert.equal(servedCollectors.size, 3, 'all writer groups receive an opportunity during API refills');
  await prisma.atsPublicCapacityLease.deleteMany({ where: { requestedAt: { not: null } } });
  // Simulate successful consumer progress; keep every immutable manifest.
  await prisma.atsIngestionSegment.updateMany({ where: { batchId: publication.id }, data: { status: 'processed', processingOffset: 25, processedAt: now } });
  await prisma.atsIngestionBatch.update({ where: { id: publication.id }, data: { status: 'processed', processedAt: now } });

  const turns = await Promise.all(Array.from({ length: 8 }, () => reserveAtsServiceTurn('concurrent', [
    { key: 'current', priority: 0, readySince: +now - 86400000 },
    { key: 'recovery', priority: 1, readySince: +now - 86400000 },
  ], { now })));
  assert.equal(new Set(turns.map(t => t!.token)).size, 8);
  assert.ok(turns.some(t => t!.key === 'recovery'));
  await Promise.all(turns.map(t => finishAtsServiceTurn(t!, true, new Date(+now + 1000))));
  assert.equal(Object.keys((await readAtsServiceState('concurrent')).pending).length, 0);

  for (let n = 0; n < 120; n++) {
    await prisma.atsCompany.create({ data: { slug: `capacity-${n}`, platform: 'workday', acquisitionEngine: 'v2',
      status: n < 20 ? 'parked' : 'active', failCount: n < 20 ? 1 : 0, checkDay: day, nextCheckDate: new Date(+now - 86400000) } });
    await prisma.atsIngestionBatch.create({ data: { slug: `capacity-${n}`, platform: 'workday', writerMode: 'v2',
      acquisitionPhase: n >= 118 ? 'enrichment' : 'listing', nextAcquireAt: new Date(+now - 1000),
      acquisitionClaimToken: n === 117 ? 'live-fixture-claim' : null,
      acquisitionLeaseExpiresAt: n === 117 ? new Date(+now + 60000) : null,
      lastError: n < 20 ? 'HTTP 404' : null } });
  }
  const heldDate = new Date(+now + 86400000);
  const held = await prisma.atsIngestionBatch.update({ where: { id: (await prisma.atsIngestionBatch.findFirstOrThrow({ where: { slug: 'capacity-116' } })).id },
    data: { nextAcquireAt: heldDate } });
  const demand = await atsV2ShadowLanePlan(now);
  assert.equal(demand.coverageEligible, 0, 'due board dates with existing batches are not new coverage');
  assert.equal(demand.listingEligible, 116, 'future holds and live claims are excluded');
  assert.equal(demand.drainEligible, 2);
  const plan = await atsV2RuntimeLanePlan(8, now);
  assert.notEqual(plan.reason, 'draining', 'listing backlog must not count as saturated downstream demand');
  assert.equal(plan.totalSlots, 8);

  const firstClaim = await claimNextAtsV2Continuation({ now, pausedPlatforms: [] });
  assert.ok(firstClaim?.serviceTurn);
  await finishAtsV2Claim({ claim: firstClaim, yieldReason: 'page_budget', nextAcquireAt: now });
  await finishAtsServiceTurn(firstClaim.serviceTurn, true, new Date(+now + 1000));
  const later = new Date(+now + 16 * 60000);
  const recoveryClaim = await claimNextAtsV2Continuation({ now: later, pausedPlatforms: [] });
  assert.equal(recoveryClaim?.serviceTurn?.key, 'recovery', 'real saved recovery claims receive the aged opportunity');
  await finishAtsV2Claim({ claim: recoveryClaim!, yieldReason: 'page_budget', nextAcquireAt: later });
  await finishAtsServiceTurn(recoveryClaim!.serviceTurn!, true, new Date(+later + 1000));

  await prisma.atsCompany.create({ data: { slug: 'fresh-eligible', platform: 'workday', acquisitionEngine: 'v2',
    checkDay: day, nextCheckDate: now } });
  await prisma.atsCompany.create({ data: { slug: 'first-held', platform: 'zohorecruit', acquisitionEngine: 'v2',
    checkDay: day, nextCheckDate: now, firstCollectionState: 'waiting', firstCollectionHoldReason: 'Operator size review' } });
  assert.equal((await atsV2ShadowLanePlan(now)).coverageEligible, 1, 'explicit first-collection holds remain excluded');
  await prisma.atsAcquisitionRuntimeGate.update({ where: { id: 'global' }, data: { admissionState: 'draining' } });
  const intakePaused = await atsV2ShadowLanePlan(now);
  assert.equal(intakePaused.coverageEligible, 0); assert.ok(intakePaused.continuationEligible > 0);
  await prisma.atsAcquisitionRuntimeGate.update({ where: { id: 'global' }, data: { admissionState: 'open' } });

  await prisma.providerCircuit.create({ data: { provider: 'ATS-workday', state: 'open', openUntil: new Date(+now + 60000) } });
  const paused = await atsV2ShadowLanePlan(now);
  assert.equal(paused.listingEligible, 0); assert.equal(paused.drainEligible, 2, 'downloaded work retains eligibility during a listing pause');
  await prisma.providerCircuit.update({ where: { provider: 'ATS-workday' }, data: { openUntil: new Date(+now - 1) } });
  await prisma.atsIngestionBatch.updateMany({ where: { acquisitionPhase: 'enrichment' }, data: { nextAcquireAt: heldDate } });
  const lent = await prisma.$transaction(tx => withAtsListingCapacity(tx, now, 1, async () => 'lent'));
  assert.equal(lent, 'lent', 'future-held drain work below volume limits cannot block lending');
  // A low-volume saved backlog exceeding the intake allowance may use idle
  // workers; it must not admit more boards or bring future-held work forward.
  await prisma.atsCompany.update({ where: { slug_platform: { slug: 'fresh-eligible', platform: 'workday' } }, data: { checkDay: (day + 1) % 4 } });
  await prisma.atsIngestionBatch.updateMany({ where: { slug: { startsWith: 'capacity-' }, acquisitionPhase: 'listing',
    lastError: null }, data: { rawObservationCount: 10, acquisitionBytes: BigInt(10000) } });
  const loanPlan = await atsV2RuntimeLanePlan(8, now);
  assert.equal(loanPlan.listingConcurrencyLimit, 2);
  assert.equal(loanPlan.coverageSlots, 0);
  assert.equal(await admitAtsV2Board({ slug: 'fresh-eligible', platform: 'workday', now }), null);
  const loans: NonNullable<Awaited<ReturnType<typeof claimNextAtsV2Continuation>>>[] = [];
  // One fixture already holds a live listing claim. Fill the other seven
  // worker opportunities through the real selector and claim transaction.
  for (let n = 0; n < 7; n++) {
    const claim = await claimNextAtsV2Continuation({ now, listingConcurrencyLimit: loanPlan.listingConcurrencyLimit, pausedPlatforms: [] });
    assert.ok(claim, 'existing listings must borrow idle capacity despite the 32-board intake allowance');
    loans.push(claim);
  }
  assert.equal(new Set(loans.map(claim => claim.batchId)).size, 7);
  assert.equal(await prisma.atsIngestionBatch.count({ where: { acquisitionClaimToken: { not: null }, acquisitionLeaseExpiresAt: { gt: now } } }), 8);
  // Returning downstream work immediately stops further listing loans.
  const processing = await prisma.atsIngestionBatch.findFirstOrThrow({ where: { acquisitionPhase: 'enrichment' } });
  await prisma.atsIngestionBatch.update({ where: { id: processing.id }, data: { nextAcquireAt: now } });
  const drainClaim = await claimNextAtsV2Continuation({ now, listingConcurrencyLimit: 2, pausedPlatforms: [] });
  assert.equal(drainClaim?.acquisitionPhase, 'enrichment');
  await finishAtsV2Claim({ claim: drainClaim!, yieldReason: 'detail_retry_wait', nextAcquireAt: heldDate });
  await finishAtsServiceTurn(drainClaim!.serviceTurn!, true, new Date(+now + 1000));
  // The same held work still prevents lending when retained volume is full.
  await prisma.atsIngestionBatch.update({ where: { id: held.id }, data: { rawObservationCount: 60000, acquisitionBytes: BigInt(800000000) } });
  const bounded = await prisma.$transaction(tx => withAtsListingCapacity(tx, now, 1, async () => 'must-not-run'));
  assert.equal(bounded, null, 'an already occupied producer stays bounded under retained volume pressure');
  assert.equal(await claimNextAtsV2Continuation({ now, listingConcurrencyLimit: 2, pausedPlatforms: [] }), null,
    'retained volume also stops new loans through the real selector');
  for (const claim of loans) {
    await finishAtsV2Claim({ claim, yieldReason: 'page_budget', nextAcquireAt: now });
    await finishAtsServiceTurn(claim.serviceTurn!, true, new Date(+now + 1000));
  }
  assert.deepEqual(await prisma.job.findUniqueOrThrow({ where: { id: job.id } }), protectedBefore);
  assert.equal(+(await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: held.id } })).nextAcquireAt!, +heldDate);
  assert.ok(await prisma.atsIngestionBatch.count({ where: atsContinuationEligibilityWhere(now, []) }) > 0);
  console.log('PostgreSQL capacity checks passed: concurrent public reservations, lease fencing, persistent service accounting, exact demand, pause handling, bounded lending, retained retries and score preservation.');
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
