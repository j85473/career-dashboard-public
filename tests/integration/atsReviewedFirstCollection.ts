/** Real row-lock and raw-writer checks, exclusively in a disposable database. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { PrismaClient } from '../../src/lib/prismaClient';
import { firstCollectionSelectionWhere, firstCollectionHealth, reconcileFirstCollectionCompletion, reserveFirstCollection,
  firstCollectionBodyLimits } from '../../src/lib/atsFirstCollectionAdmission';
import { REVIEWED_FIRST_COLLECTION_POLICY_ID } from '../../src/lib/atsReviewedFirstCollection';

const databaseUrl = process.env.ATS_FIRST_COLLECTION_TEST_DATABASE_URL || '';
if (!/^\/ats_first_collection_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname)) throw new Error('A dedicated disposable database is required');
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const boards = [
  { platform: 'clearcompany', slug: '11111111-1111-1111-1111-111111111111', jobsFound: 251 },
  { platform: 'symphony', slug: 'hgv', jobsFound: 1183 },
  { platform: 'symphony', slug: 'victoriassecret', jobsFound: 1369 },
];

async function main() {
  const sql = new Client({ connectionString: databaseUrl });
  await sql.connect();
  try {
    await sql.query(readFileSync('prisma/migrations/20261019170000_symphony_talent_acquisition/migration.sql', 'utf8'));
    await sql.query(`CREATE TRIGGER ats_first_collection_board_guard BEFORE INSERT ON "AtsCompany" FOR EACH ROW EXECUTE FUNCTION ats_first_collection_board_guard();
      CREATE TRIGGER ats_first_collection_batch_guard BEFORE INSERT ON "AtsIngestionBatch" FOR EACH ROW EXECUTE FUNCTION ats_first_collection_batch_guard();`);
  } finally { await sql.end(); }
  await db.atsFirstCollectionPolicy.create({ data: { id: 'new-providers', mode: 'capacity', dailyBoardLimit: 0, maxUnfinished: 32, healthObservedAt: new Date() } });
  await db.atsFirstCollectionPolicy.create({ data: { id: REVIEWED_FIRST_COLLECTION_POLICY_ID, mode: 'capacity', dailyBoardLimit: 0,
    maxUnfinished: 1, maxCatalogueJobs: 5000, pilotBoards: boards.map(b => `${b.platform}::${b.slug}`) } });
  await db.atsAcquisitionRuntimeGate.create({ data: { id: 'global', admissionState: 'open' } });
  for (const board of boards) {
    await db.atsCompany.create({ data: { ...board, checkDay: 1, acquisitionEngine: 'v2' } });
    await db.atsCompany.update({ where: { slug_platform: { platform: board.platform, slug: board.slug } }, data: { firstCollectionState: 'ready' } });
  }
  const unreviewed = { platform: 'clearcompany', slug: '22222222-2222-2222-2222-222222222222' };
  await db.atsCompany.create({ data: { ...unreviewed, checkDay: 1, jobsFound: 1500 } });
  await db.atsCompany.update({ where: { slug_platform: unreviewed }, data: { firstCollectionState: 'ready' } });
  const selection = await firstCollectionSelectionWhere(db);
  const selected = await db.atsCompany.findMany({ where: { AND: [selection, { platform: 'symphony' }] } });
  assert.equal(selected.length, 0, 'only the smallest reviewed catalogue enters selection initially');
  assert.deepEqual(await firstCollectionBodyLimits(db, boards[1]), { maximumJobs: 5000, maximumBytes: 5242880 });
  assert.equal((await firstCollectionBodyLimits(db, unreviewed)).maximumJobs, 250);
  const start = (board: { platform: string; slug: string }, id: string) => db.$transaction(async tx => {
    if (!await reserveFirstCollection(tx, board, id)) return null;
    return tx.atsIngestionBatch.create({ data: { id, platform: board.platform, slug: board.slug, writerMode: 'v2' } });
  }, { timeout: 30_000 });
  const backlog = { platform: 'greenhouse', slug: 'ordinary-publication-backlog' };
  await db.atsCompany.create({ data: { ...backlog, checkDay: 1 } });
  await db.atsIngestionBatch.create({ data: { id: 'ordinary-backlog', ...backlog, writerMode: 'legacy', status: 'queued', jobCount: 1750 } });
  assert.equal(await start(boards[0], 'high-watermark-full'), null, 'the reviewed window must fit below the existing hard ceiling');
  await db.atsIngestionBatch.update({ where: { id: 'ordinary-backlog' }, data: { jobCount: 1500 } });
  assert.equal((await firstCollectionHealth(db)).healthy, false, 'ordinary starts retain the low-watermark requirement');
  assert.equal((await firstCollectionHealth(db, 250, 5242880, new Date(), 'high')).healthy, true, 'the reviewed window fits without raising the hard ceiling');
  const results = await Promise.all(boards.map((board, i) => start(board, `reviewed-${i}`)));
  assert.equal(results.filter(Boolean).length, 1, 'simultaneous hosts share exactly one reviewed reservation');
  const first = results.find(Boolean)!;
  const remaining = boards.filter(b => b.slug !== first.slug || b.platform !== first.platform);
  await assert.rejects(db.atsIngestionBatch.create({ data: { id: 'raw-unreserved', platform: remaining[0].platform, slug: remaining[0].slug } }), 'raw SQL/batch callers cannot bypass the reservation');
  await db.atsIngestionBatch.update({ where: { id: first.id }, data: { status: 'partial', nextAcquireAt: new Date(Date.now() + 3600000), lastError: 'retained retry' } });
  assert.equal(await start(remaining[0], 'must-wait-retry'), null, 'a future retry still occupies the reviewed slot');
  await db.atsIngestionBatch.update({ where: { id: first.id }, data: { status: 'synchronized' } });
  assert.equal(await start(remaining[0], 'must-wait-persistence'), null, 'download completion alone does not free the slot');
  await db.atsIngestionBatch.update({ where: { id: first.id }, data: { status: 'processed', processedAt: new Date(), processingErrorCount: 1 } });
  assert.equal(await start(remaining[0], 'must-wait-error'), null, 'processing errors retain the slot');
  await db.atsIngestionBatch.update({ where: { id: first.id }, data: { processingErrorCount: 0 } });
  const second = await start(remaining[0], 'second-after-completion');
  assert.ok(second, 'successful zero-error persistence immediately permits the next board');
  await db.atsIngestionBatch.update({ where: { id: second.id }, data: { status: 'processed', processedAt: new Date() } });
  await reconcileFirstCollectionCompletion(db);
  assert.equal(await start(unreviewed, 'unreviewed-too-large'), null, 'an unreviewed board cannot borrow the raised allowance');
  await db.atsAcquisitionRuntimeGate.update({ where: { id: 'global' }, data: { admissionState: 'draining' } });
  assert.equal(await start(remaining[1], 'runtime-gate'), null);
  await db.atsAcquisitionRuntimeGate.update({ where: { id: 'global' }, data: { admissionState: 'open' } });
  await db.atsFirstCollectionPolicy.update({ where: { id: 'new-providers' }, data: { mode: 'held' } });
  assert.equal(await start(remaining[1], 'operator-hold'), null);
  await db.atsFirstCollectionPolicy.update({ where: { id: 'new-providers' }, data: { mode: 'capacity' } });
  await db.atsFirstCollectionPolicy.update({ where: { id: REVIEWED_FIRST_COLLECTION_POLICY_ID }, data: { mode: 'held' } });
  assert.equal(await start(remaining[1], 'reviewed-hold'), null);
  assert.equal((await firstCollectionBodyLimits(db, remaining[1])).maximumJobs, 5000, 'holding admission retains the saved allowance');
  await db.atsFirstCollectionPolicy.update({ where: { id: REVIEWED_FIRST_COLLECTION_POLICY_ID }, data: { mode: 'capacity' } });
  assert.ok(await start(remaining[1], 'third-after-completion'));
  assert.equal((await db.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: 'new-providers' } })).maxCatalogueJobs, 250);
  console.log('Real PostgreSQL concurrent admission, exact-board scope, raw-writer fence, retained retries, persistence completion and operator gates passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
