/** Caller supplies an empty current-schema disposable database. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const url = process.env.ATS_FIRST_COLLECTION_TEST_DATABASE_URL || '';
if (!/^\/ats_first_collection_test_[a-z0-9_]+$/.test(new URL(url).pathname)) throw Error('Disposable first-collection test database required');
const connection = new Client({ connectionString: url });

async function main() {
  await connection.connect();
  await connection.query(readFileSync('prisma/migrations/20261019170000_symphony_talent_acquisition/migration.sql', 'utf8'));
  await connection.query(`CREATE TRIGGER ats_first_collection_board_guard BEFORE INSERT ON "AtsCompany" FOR EACH ROW EXECUTE FUNCTION ats_first_collection_board_guard();
    CREATE TRIGGER ats_first_collection_batch_guard BEFORE INSERT ON "AtsIngestionBatch" FOR EACH ROW EXECUTE FUNCTION ats_first_collection_batch_guard();
    INSERT INTO "AtsCompany" (slug,platform,"checkDay","firstCollectionState") VALUES ('existing','cornerstone',1,'established');
    INSERT INTO "Job" (id,title,company,"postedAt","updatedAt","aimFitScore","reqFitScore",status) VALUES ('preserved','Channel Manager','Example Inc',NOW(),NOW(),91,87,'interviewing');`);
  const before = await connection.query('SELECT row_to_json(j) AS row FROM "Job" j WHERE id=\'preserved\'');
  await connection.query(readFileSync('prisma/migrations/20261110180000_expanded_public_ats_admission/migration.sql', 'utf8'));
  for (const platform of ['cornerstone', 'hireology', 'polymer']) {
    await connection.query('INSERT INTO "AtsCompany" (slug,platform,"checkDay","firstCollectionState") VALUES ($1,$2,1,\'established\')', ['new', platform]);
    const board = await connection.query('SELECT "firstCollectionState" AS state FROM "AtsCompany" WHERE slug=\'new\' AND platform=$1', [platform]);
    assert.equal(board.rows[0].state, 'waiting');
    await assert.rejects(connection.query('INSERT INTO "AtsIngestionBatch" (id,slug,platform,"updatedAt") VALUES ($1,\'new\',$2,NOW())', [`unreserved-${platform}`, platform]), /durable admission reservation/);
    await connection.query('UPDATE "AtsCompany" SET "firstCollectionState"=\'admitted\',"firstCollectionBatchId"=$1 WHERE slug=\'new\' AND platform=$2', [`reserved-${platform}`, platform]);
    await assert.rejects(connection.query('INSERT INTO "AtsIngestionBatch" (id,slug,platform,"updatedAt") VALUES ($1,\'new\',$2,NOW())', [`wrong-${platform}`, platform]), /durable admission reservation/);
    await connection.query('INSERT INTO "AtsIngestionBatch" (id,slug,platform,"updatedAt") VALUES ($1,\'new\',$2,NOW())', [`reserved-${platform}`, platform]);
  }
  const existing = await connection.query('SELECT "firstCollectionState" AS state FROM "AtsCompany" WHERE slug=\'existing\' AND platform=\'cornerstone\'');
  assert.equal(existing.rows[0].state, 'established');
  assert.deepEqual((await connection.query('SELECT row_to_json(j) AS row FROM "Job" j WHERE id=\'preserved\'')).rows, before.rows);
  console.log('All three raw-writer admission fences passed; existing board state, job lifecycle and scores were preserved.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => connection.end());
