import assert from 'node:assert/strict';
import { Client } from 'pg';
import { firstCollectionCandidateQuery } from '../../src/lib/atsFirstCollectionFairness';

const database = process.env.ATS_FIRST_COLLECTION_TEST_DATABASE_URL || '';
if (!/^\/ats_first_collection_test_[a-z0-9_]+$/.test(new URL(database).pathname)) throw Error('A dedicated disposable database is required');
const db = new Client({ connectionString: database });
async function main() {
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE "AtsFirstCollectionCandidate" (
      platform text, slug text, state text DEFAULT 'discovered', "lastValidationStartedAt" timestamp,
      "nextValidationAt" timestamp DEFAULT '2026-11-11T00:00:00', "createdAt" timestamp DEFAULT '2026-11-10T00:00:00')`);
    await db.query(`INSERT INTO "AtsFirstCollectionCandidate" (platform,slug,"lastValidationStartedAt")
      SELECT 'cornerstone','older-' || n,'2026-11-11T21:00:00'::timestamp FROM generate_series(1,100) n`);
    for (const platform of ['homerun', 'softgarden', 'dvinci', 'flatchr']) {
      await db.query(`INSERT INTO "AtsFirstCollectionCandidate" (platform,slug,"createdAt")
        VALUES ($1,'launch','2026-11-11T00:00:00'),($1,'later','2026-11-11T01:00:00')`, [platform]);
    }
    await db.query(`INSERT INTO "AtsFirstCollectionCandidate" (platform,slug,state,"nextValidationAt")
      VALUES ('polymer','held','discovered','2026-11-12T00:00:00'),('gem','review','size_review','2026-11-10T00:00:00'),
        ('hireology','retired','retired','2026-11-10T00:00:00')`);
    const seen = new Set<string>();
    for (let turn = 0; turn < 4; turn++) {
      const now = new Date(Date.parse('2026-11-11T22:00:00Z') + turn * 1000);
      const query = firstCollectionCandidateQuery(now);
      const candidate = (await db.query(query.text, query.values)).rows[0];
      assert(!seen.has(candidate.platform), 'a large backlog cannot take another provider’s first turn');
      assert.equal(candidate.slug, 'launch', 'oldest candidate within a provider goes first');
      seen.add(candidate.platform);
      await db.query(`UPDATE "AtsFirstCollectionCandidate" SET "lastValidationStartedAt"=($1::timestamptz AT TIME ZONE 'UTC'),state='validated'
        WHERE platform=$2 AND slug=$3`, [now.toISOString(), candidate.platform, candidate.slug]);
    }
    assert.deepEqual([...seen].sort(), ['dvinci', 'flatchr', 'homerun', 'softgarden']);
    const query = firstCollectionCandidateQuery(new Date('2026-11-11T22:01:00Z'));
    assert.equal((await db.query(query.text, query.values)).rows[0].platform, 'cornerstone', 'older providers retain their next turn');
    assert.equal((await db.query(`SELECT count(*)::int n FROM "AtsFirstCollectionCandidate" WHERE state IN ('retired','size_review')`)).rows[0].n, 2);
    console.log('Provider rotation, oldest candidate order, future retries and review/retirement preservation passed.');
  } finally { await db.query('ROLLBACK'); await db.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
