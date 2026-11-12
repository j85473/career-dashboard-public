/** Complete controller/reservation checks, exclusively in a disposable database. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { PrismaClient } from '../../src/lib/prismaClient';
import { tickFirstCollections } from '../../src/lib/atsFirstCollectionController';
import { firstCollectionCounts, reserveFirstCollection, firstCollectionBodyLimits, reviewedFirstCollectionOccupancy } from '../../src/lib/atsFirstCollectionAdmission';

const url = process.env.ATS_FIRST_COLLECTION_TEST_DATABASE_URL || '';
if (!/^\/ats_first_collection_test_[a-z0-9_]+$/.test(new URL(url).pathname)) throw Error('A dedicated disposable database is required');
const db = new PrismaClient({ datasourceUrl: url });
async function main() {
  const sql = new Client({ connectionString: url });
  await sql.connect();
  try {
    await sql.query(readFileSync('prisma/migrations/20261110193000_additional_public_ats_admission/migration.sql', 'utf8'));
    await sql.query(`CREATE TRIGGER ats_first_collection_board_guard BEFORE INSERT ON "AtsCompany" FOR EACH ROW EXECUTE FUNCTION ats_first_collection_board_guard();
      CREATE TRIGGER ats_first_collection_batch_guard BEFORE INSERT ON "AtsIngestionBatch" FOR EACH ROW EXECUTE FUNCTION ats_first_collection_batch_guard();`);
  } finally { await sql.end(); }
  await db.atsFirstCollectionPolicy.create({ data: { id: 'new-providers', mode: 'capacity', dailyBoardLimit: 0, maxUnfinished: 32 } });
  await db.atsFirstCollectionPolicy.create({ data: { id: 'reviewed-provider-backlog', mode: 'capacity', dailyBoardLimit: 0,
    maxUnfinished: 1, maxCatalogueJobs: 250, pilotBoards: [ 'homerun::*', 'softgarden::*', 'dvinci::*', 'flatchr::*'] } });
  await db.atsAcquisitionRuntimeGate.create({ data: { id: 'global', admissionState: 'open' } });
  for (let n = 0; n < 32; n++) {
    const identity = { platform: 'gem', slug: `ordinary-${n}` };
    await db.atsCompany.create({ data: { ...identity, checkDay: 1 } });
    await db.atsCompany.update({ where: { slug_platform: identity }, data: { firstCollectionState: 'admitted' } });
  }
  assert.equal((await firstCollectionCounts(db, new Date(), true)).unfinished, 32);
  const legacy = { platform: 'clearcompany', slug: '11111111-1111-1111-1111-111111111111' };
  await db.atsFirstCollectionPolicy.create({ data: { id: 'reviewed-oversized', mode: 'capacity', dailyBoardLimit: 0,
    maxUnfinished: 1, maxCatalogueJobs: 5000, pilotBoards: [`${legacy.platform}::${legacy.slug}`] } });
  await db.atsCompany.create({ data: { ...legacy, jobsFound: 300, checkDay: 1 } });
  await db.atsCompany.update({ where: { slug_platform: legacy }, data: { firstCollectionState: 'ready' } });
  await db.$transaction(async tx => {
    assert.equal(await reserveFirstCollection(tx, legacy, 'legacy-held'), true);
    await tx.atsIngestionBatch.create({ data: { ...legacy, id: 'legacy-held', writerMode: 'v2', status: 'partial',
      nextAcquireAt: new Date(Date.now() + 3600_000), lastError: 'Existing large-board retry' } });
  });
  const scored = await db.job.create({ data: { title: 'Saved role', company: 'Saved employer', postedAt: new Date(),
    status: 'interviewing', aimFitScore: 91, reqFitScore: 88 } });
  const boards = ['homerun', 'softgarden', 'dvinci', 'flatchr'].flatMap(platform => [1, 2].map(n => ({
    platform, slug: platform === 'softgarden' ? `fixture-${n}.softgarden.io` : platform === 'dvinci' ? `fixture-${n}.dvinci-hr.com` : `fixture-${n}`,
  })));
  await db.atsFirstCollectionCandidate.createMany({ data: boards });
  await db.atsFirstCollectionCandidate.create({ data: { platform: 'cornerstone', slug: 'older.csod.com::1::default', createdAt: new Date(Date.now() - 2 * 86_400_000) } });
  const held = { platform: 'homerun', slug: 'future-held' };
  await db.atsFirstCollectionCandidate.create({ data: { ...held, nextValidationAt: new Date(Date.now() + 86_400_000), lastError: 'Existing retry' } });
  let calls = 0;
  const validate = async () => { calls++; return { success: true, jobsFound: 2 }; };
  const tick = () => tickFirstCollections(validate, new Date(), db);
  const started = new Set<string>();
  for (let n = 0; n < 4; n++) {
    const results = await Promise.all([tick(), tick()]);
    assert.equal(results.filter(r => r.outcome === 'ready').length, 1, 'concurrent validators share one reviewed ready slot');
    const ready = await db.atsCompany.findFirstOrThrow({ where: { firstCollectionState: 'ready' } });
    assert(!started.has(ready.platform), 'all enrolled providers get turns'); started.add(ready.platform);
    assert.equal((await tick()).outcome, 'waiting_for_admission_conditions', 'ready work occupies the serial slot');
    const identity = { platform: ready.platform, slug: ready.slug };
    assert.equal((await firstCollectionBodyLimits(db, identity)).maximumJobs, 250);
    await db.atsCompany.update({ where: { slug_platform: identity }, data: { jobsFound: 251 } });
    assert.equal(await db.$transaction(tx => reserveFirstCollection(tx, identity, `oversized-${n}`)), false);
    await db.atsCompany.update({ where: { slug_platform: identity }, data: { jobsFound: 2 } });
    const id = `backlog-batch-${n}`;
    await db.$transaction(async tx => {
      assert.equal(await reserveFirstCollection(tx, identity, id), true, 'reviewed starts can advance while the ordinary queue is full');
      await tx.atsIngestionBatch.create({ data: { id, ...identity, writerMode: 'v2', status: 'partial', nextAcquireAt: new Date(Date.now() + 3600_000) } });
    });
    const policy = await db.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: 'reviewed-provider-backlog' } });
    assert.equal(await reviewedFirstCollectionOccupancy(db, policy, new Date()), 0, 'a future retry lends the slot while remaining saved');
    assert.equal((await db.atsIngestionBatch.findUniqueOrThrow({ where: { id } })).status, 'partial');
    await db.atsIngestionBatch.update({ where: { id }, data: { status: 'processed', processedAt: new Date(), processingErrorCount: 1 } });
    assert.equal((await tick()).outcome, 'waiting_for_admission_conditions', 'processing errors do not release the slot');
    await db.atsIngestionBatch.update({ where: { id }, data: { processingErrorCount: 0 } });
  }
  assert.equal(calls, 4);
  assert.equal((await db.atsIngestionBatch.findUniqueOrThrow({ where: { id: 'legacy-held' } })).lastError, 'Existing large-board retry');
  assert.equal((await firstCollectionBodyLimits(db, legacy)).maximumJobs, 5000);
  assert.deepEqual([...started].sort(), ['dvinci', 'flatchr', 'homerun', 'softgarden']);
  assert.equal((await db.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: 'new-providers' } })).maxUnfinished, 32);
  const saved = await db.job.findUniqueOrThrow({ where: { id: scored.id } });
  assert.deepEqual([saved.status, saved.aimFitScore, saved.reqFitScore], ['interviewing', 91, 88]);
  assert.equal((await db.atsFirstCollectionCandidate.findUniqueOrThrow({ where: { slug_platform: held } })).lastError, 'Existing retry');

  const backlog = { platform: 'greenhouse', slug: 'volume-backlog' };
  await db.atsCompany.create({ data: { ...backlog, checkDay: 1 } });
  await db.atsIngestionBatch.create({ data: { ...backlog, id: 'volume', status: 'queued', writerMode: 'legacy', jobCount: 1750 } });
  assert.equal((await tick()).outcome, 'waiting_for_admission_conditions', 'hard persistence ceiling stops new validation');
  await db.atsIngestionBatch.update({ where: { id: 'volume' }, data: { jobCount: 1300 } });
  await db.atsFirstCollectionPolicy.update({ where: { id: 'reviewed-provider-backlog' }, data: { mode: 'held' } });
  assert.equal((await tick()).outcome, 'waiting_for_admission_conditions', 'reviewed operator pause is honored');
  await db.atsFirstCollectionPolicy.update({ where: { id: 'reviewed-provider-backlog' }, data: { mode: 'capacity' } });
  const before = calls;
  const unavailable = await tickFirstCollections(async () => ({ success: false, reason: 'Feed HTTP 404' }), new Date(), db);
  assert.equal(unavailable.outcome, 'validation_deferred');
  const retry = await db.atsFirstCollectionCandidate.findFirstOrThrow({ where: { lastError: 'Feed HTTP 404' } });
  assert(retry.nextValidationAt.getTime() > Date.now() + 6 * 86_400_000, 'unavailable candidates retain their normal retry date');
  const oversized = await tickFirstCollections(async () => ({ success: true, jobsFound: 251 }), new Date(), db);
  assert.equal(oversized.outcome, 'size_review', 'enrolled boards cannot borrow the 5,000-job oversized allowance');
  const changed = await tickFirstCollections(async () => {
    await db.atsFirstCollectionPolicy.update({ where: { id: 'reviewed-provider-backlog' }, data: { mode: 'held' } });
    return { success: true, jobsFound: 2 };
  }, new Date(), db);
  assert.equal(changed.outcome, 'policy_changed_during_validation');
  assert.equal(await db.atsCompany.count({ where: { firstCollectionState: 'ready' } }), 0);
  assert.equal(calls, before);
  await db.atsFirstCollectionPolicy.update({ where: { id: 'reviewed-provider-backlog' }, data: { mode: 'capacity' } });
  await db.atsAcquisitionRuntimeGate.update({ where: { id: 'global' }, data: { admissionState: 'draining' } });
  assert.equal((await tick()).outcome, 'waiting_for_admission_conditions', 'runtime admission gate remains authoritative');
  console.log('Real PostgreSQL provider backlog refill, concurrent validation, serial reservation, retries, persistence errors, volume gates, operator pauses, size review and saved-score preservation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
