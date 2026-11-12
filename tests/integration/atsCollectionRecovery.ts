/** Real admission SQL and reservations; exclusively in a disposable database. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { PrismaClient } from '../../src/lib/prismaClient';
import { firstCollectionCounts, reserveFirstCollection, reviewedFirstCollectionOccupancy } from '../../src/lib/atsFirstCollectionAdmission';
import { tickFirstCollections } from '../../src/lib/atsFirstCollectionController';
import { recoverFalseHomerunDetailPause } from '../../src/lib/atsFalseDetailPauseRecovery';

const url = process.env.ATS_FIRST_COLLECTION_TEST_DATABASE_URL || '';
if (!/^\/ats_first_collection_test_[a-z0-9_]+$/.test(new URL(url).pathname)) throw Error('A dedicated disposable database is required');
const db = new PrismaClient({ datasourceUrl: url });
const now = () => new Date();

async function main() {
  const sql = new Client({ connectionString: url });
  await sql.connect();
  try {
    await sql.query(readFileSync('prisma/migrations/20261110193000_additional_public_ats_admission/migration.sql', 'utf8'));
    await sql.query(`CREATE TRIGGER ats_first_collection_board_guard BEFORE INSERT ON "AtsCompany" FOR EACH ROW EXECUTE FUNCTION ats_first_collection_board_guard();
      CREATE TRIGGER ats_first_collection_batch_guard BEFORE INSERT ON "AtsIngestionBatch" FOR EACH ROW EXECUTE FUNCTION ats_first_collection_batch_guard();`);
  } finally { await sql.end(); }
  await db.atsFirstCollectionPolicy.create({ data: { id: 'new-providers', mode: 'capacity', dailyBoardLimit: 0, maxUnfinished: 32 } });
  await db.atsAcquisitionRuntimeGate.create({ data: { id: 'global', admissionState: 'open' } });
  const saved = await db.job.create({ data: { title: 'Existing interview', company: 'Existing employer', postedAt: now(),
    status: 'interviewing', aimFitScore: 88, reqFitScore: 92 } });
  const past = new Date(Date.now() - 3600_000), future = new Date(Date.now() + 3600_000);
  for (let n = 0; n < 74; n++) {
    const board = { platform: 'cornerstone', slug: `retained-${n}.csod.com::1::default` };
    const id = `retained-${n}`;
    await db.atsCompany.create({ data: { ...board, checkDay: 1, acquisitionEngine: 'v2' } });
    await db.atsCompany.update({ where: { slug_platform: board }, data: { firstCollectionState: 'admitted', firstCollectionBatchId: id } });
    await db.atsIngestionBatch.create({ data: { id, ...board, writerMode: 'v2', status: 'partial', acquisitionPhase: 'enrichment',
      rawObservationCount: 2, canonicalOccurrenceCount: 2, terminalItemCount: 1, publishedItemCount: 1, nextAcquireAt: past } });
    await db.atsIngestionItem.create({ data: { batchId: id, canonicalOrdinal: 1, rawHash: id,
      detailAttemptCount: 4, nextDetailAt: past, retryCode: 'posting_mismatch', retryScope: 'posting' } });
    await db.atsIngestionSegment.create({ data: { batchId: id, segmentOrdinal: 0, segmentSize: 25, firstOrdinal: 0, lastOrdinal: 0,
      itemCount: 1, manifestHash: id, enrichmentVersion: 1, status: 'published', nextProcessAt: past,
      holdReason: 'cornerstone downloaded work awaits a verified employer', retryCode: n % 2 ? 'employer_unverified' : null } });
  }
  for (const timezone of ['UTC', 'America/Chicago']) {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${timezone}'`);
      assert.equal((await firstCollectionCounts(tx, now(), true)).unfinished, 0, '74 retained recovery boards cannot close fresh intake');
    });
  }
  await db.atsIngestionBatch.update({ where: { id: 'retained-0' }, data: { acquisitionClaimToken: 'active-recovery', acquisitionLeaseExpiresAt: future } });
  assert.equal((await firstCollectionCounts(db, now(), true)).unfinished, 1, 'active recovery reserves capacity');
  await db.atsIngestionBatch.update({ where: { id: 'retained-0' }, data: { acquisitionClaimToken: null, acquisitionLeaseExpiresAt: null } });
  await db.atsIngestionSegment.updateMany({ where: { batchId: 'retained-0' }, data: { status: 'processing' } });
  assert.equal((await firstCollectionCounts(db, now(), true)).unfinished, 1, 'in-flight persistence always reserves capacity');
  await db.atsIngestionSegment.updateMany({ where: { batchId: 'retained-0' }, data: { status: 'published', retryCode: 'network_failure' } });
  assert.equal((await firstCollectionCounts(db, now(), true)).unfinished, 1, 'an unrelated retry classification is not employer recovery');
  await db.atsIngestionSegment.updateMany({ where: { batchId: 'retained-0' }, data: { retryCode: 'employer_unverified' } });
  await db.atsFirstCollectionCandidate.createMany({ data: [{ platform: 'polymer', slug: 'fresh-polymer' }, { platform: 'hireology', slug: 'fresh-hireology' }] });
  for (let n = 0; n < 2; n++) assert.equal((await tickFirstCollections(async () => ({ success: true, jobsFound: 2 }), now(), db)).outcome, 'ready');
  assert.equal(await db.atsCompany.count({ where: { firstCollectionState: 'ready' } }), 2, 'ordinary providers refill while evidence retries remain');

  const policy = await db.atsFirstCollectionPolicy.create({ data: { id: 'reviewed-provider-backlog', mode: 'capacity', dailyBoardLimit: 0,
    maxUnfinished: 1, maxCatalogueJobs: 250, pilotBoards: ['homerun::*', 'softgarden::*', 'dvinci::*', 'flatchr::*'] } });
  const retained = { platform: 'homerun', slug: 'slow-homerun' };
  await db.atsCompany.create({ data: { ...retained, checkDay: 1, acquisitionEngine: 'v2' } });
  await db.atsCompany.update({ where: { slug_platform: retained }, data: { firstCollectionState: 'admitted', firstCollectionBatchId: 'slow' } });
  await db.atsIngestionBatch.create({ data: { id: 'slow', ...retained, writerMode: 'v2', status: 'partial', acquisitionPhase: 'enrichment', nextAcquireAt: past } });
  await db.atsIngestionItem.create({ data: { batchId: 'slow', canonicalOrdinal: 0, rawHash: 'immutable-download', rawJson: { preserved: true },
    detailAttemptCount: 8, nextDetailAt: past, retryCode: 'posting_mismatch', retryScope: 'posting' } });
  assert.equal(await reviewedFirstCollectionOccupancy(db, policy, now()), 0, 'a due posting retry also lends the small-provider slot');
  await db.atsFirstCollectionCandidate.createMany({ data: ['softgarden', 'dvinci', 'flatchr'].map(platform => ({ platform,
    slug: platform === 'softgarden' ? 'fresh.softgarden.io' : platform === 'dvinci' ? 'fresh.dvinci-hr.com' : 'fresh' })) });
  const results = await Promise.all([1, 2].map(() => tickFirstCollections(async () => ({ success: true, jobsFound: 3 }), now(), db)));
  assert.equal(results.filter(result => result.outcome === 'ready').length, 1, 'concurrent validators still share one fresh backlog slot');
  const ready = await db.atsCompany.findFirstOrThrow({ where: { firstCollectionState: 'ready', platform: { in: ['softgarden','dvinci','flatchr'] } } });
  const identity = { platform: ready.platform, slug: ready.slug };
  const reserve = () => db.$transaction(async tx => {
    const batchId = `loan-${Math.random()}`;
    if (!await reserveFirstCollection(tx, identity, batchId)) return false;
    await tx.atsIngestionBatch.create({ data: { id: batchId, ...identity, writerMode: 'v2' } });
    return true;
  });
  assert.equal((await Promise.all([reserve(), reserve()])).filter(Boolean).length, 1, 'only one exact concurrent reservation succeeds');
  assert.equal(await reviewedFirstCollectionOccupancy(db, policy, now()), 1);
  const raw = await db.atsIngestionItem.findFirstOrThrow({ where: { batchId: 'slow' } });
  assert.deepEqual([raw.rawJson, raw.detailAttemptCount, raw.nextDetailAt, raw.retryCode], [{ preserved: true }, 8, past, 'posting_mismatch']);
  assert.equal((await db.atsCompany.findUniqueOrThrow({ where: { slug_platform: retained } })).firstCollectionState, 'admitted');
  assert.equal(await db.atsCompany.count({ where: { firstCollectionState: 'admitted', platform: 'cornerstone' } }), 74);
  assert.deepEqual(await db.job.findUnique({ where: { id: saved.id } }), saved);
  assert.equal((await db.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: 'new-providers' } })).maxUnfinished, 32);
  const provider = 'ATS-homerun Details';
  const circuit = await db.providerCircuit.create({ data: { provider, state: 'open', openUntil: future, consecutiveFailures: 6,
    lastError: 'Homerun detail changed posting identity or title', lastFailureAt: past, dailyUsed: 42 } });
  await db.atsIngestionBatch.update({ where: { id: 'slow' }, data: { nextAcquireAt: future } });
  const deferredError = `ATS-homerun detail enrichment deferred by the platform circuit until ${future.toISOString()}`;
  const eligible = await db.atsIngestionItem.create({ data: { batchId: 'slow', canonicalOrdinal: 1, rawHash: 'eligible', rawJson: { saved: 'unchanged' },
    detailAttemptCount: 3, nextDetailAt: future, retryCode: 'provider_unavailable', retryScope: 'provider', detailError: deferredError } });
  const leased = await db.atsIngestionItem.create({ data: { batchId: 'slow', canonicalOrdinal: 2, rawHash: 'leased',
    detailAttemptCount: 3, nextDetailAt: future, retryCode: 'provider_unavailable', retryScope: 'provider', detailError: deferredError,
    itemClaimToken: 'owned', itemLeaseExpiresAt: new Date(Date.now() + 7200_000) } });
  const preview = await recoverFalseHomerunDetailPause(db);
  assert.equal(preview.outcome, 'preview');
  assert('eligibleItems' in preview);
  assert.equal(preview.eligibleItems, 1);
  assert.deepEqual(await db.providerCircuit.findUnique({ where: { provider } }), circuit, 'preview is read-only');
  const repairedAt = now();
  const repaired = await recoverFalseHomerunDetailPause(db, true, repairedAt);
  assert.equal(repaired.releasedItems, 1);
  assert.equal(repaired.releasedBatches, 1);
  const moved = await db.atsIngestionItem.findUniqueOrThrow({ where: { id: eligible.id } });
  assert.deepEqual({ ...moved, nextDetailAt: eligible.nextDetailAt, updatedAt: eligible.updatedAt }, eligible,
    'only the known false-pause retry clock changes');
  assert.equal(moved.nextDetailAt?.getTime(), repairedAt.getTime());
  assert.deepEqual(await db.atsIngestionItem.findUnique({ where: { id: leased.id } }), leased, 'live item claims stay untouched');
  assert.deepEqual(await db.atsIngestionItem.findUnique({ where: { id: raw.id } }), raw, 'posting-local retries stay untouched');
  const closed = await db.providerCircuit.findUniqueOrThrow({ where: { provider } });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.dailyUsed, 42);
  assert.equal(closed.lastSuccessAt, null, 'recovery never invents a successful provider response');
  assert.equal((await recoverFalseHomerunDetailPause(db, true)).outcome, 'no_matching_false_pause');
  await db.providerCircuit.update({ where: { provider }, data: { state: 'open', openUntil: future, lastError: 'network connection failed' } });
  assert.equal((await recoverFalseHomerunDetailPause(db, true)).outcome, 'no_matching_false_pause', 'genuine provider outages retain protection');
  assert.deepEqual(await db.job.findUnique({ where: { id: saved.id } }), saved);
  console.log('PostgreSQL recovery admission, 74 retained holds, UTC/Chicago, active claim/persistence, normal provider refill, concurrent backlog lending, immutable retries and scored-job preservation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
