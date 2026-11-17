import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const checker = path.resolve('scripts/deployment/check-expand-only.mjs');

function withMigration(sql: string, run: (directory: string) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'migration-policy-'));
  const directory = path.join(root, '20260808210000_test');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'migration.sql'), sql);
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('expand-only policy accepts a trigger function with internal semicolons', () => {
  withMigration(`
    CREATE TABLE "StatsTrackingEpoch" ("id" TEXT PRIMARY KEY);
    INSERT INTO "StatsTrackingEpoch" ("id") VALUES ('test');
    CREATE FUNCTION record_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER record_test_trigger AFTER UPDATE ON "Job"
    FOR EACH ROW EXECUTE FUNCTION record_test();
  `, (directory) => {
    const output = execFileSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.match(output, /Expand-only migration policy passed/);
  });
});

test('expand-only policy permits only the named ATS compatibility guard replacement', () => {
  withMigration(`
    CREATE OR REPLACE FUNCTION "guard_legacy_ats_batch_write"()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END;
    $$;
  `, (directory) => {
    const output = execFileSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.match(output, /Expand-only migration policy passed/);
  });

  withMigration(`
    CREATE OR REPLACE FUNCTION "unsafe_replacement"()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END;
    $$;
  `, (directory) => {
    const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Disallowed statements/);
  });
});

test('expand-only policy permits only the obsolete manual-scoring index replacement', () => {
  withMigration(`
    CREATE UNIQUE INDEX "ScoringBatch_one_unbundled_nonterminal_per_stage"
      ON "ScoringBatch"("stage") WHERE "runId" IS NULL;
    CREATE UNIQUE INDEX "ScoringRun_one_nonterminal_per_stage"
      ON "ScoringRun"("stage") WHERE "status" = 'exported';
    DROP INDEX "ScoringBatch_one_nonterminal_per_stage";
  `, (directory) => {
    const output = execFileSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.match(output, /Expand-only migration policy passed/);
  });

  withMigration('DROP INDEX "ScoringBatchItem_one_active_lease_per_job";', (directory) => {
    const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Disallowed statements/);
  });
});

test('expand-only policy still rejects ordinary data mutation', () => {
  withMigration('INSERT INTO "Job" ("id") VALUES (\'unsafe\');', (directory) => {
    const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Disallowed statements/);
  });
});

test('expand-only policy accepts only the dormant ATS runtime-gate seed', () => {
  const exact = `
    INSERT INTO "AtsAcquisitionRuntimeGate" (
      "id", "minimumWriterVersion", "compatibilityWriterVersion", "updatedAt"
    ) VALUES ('global', 1, 2, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING;
  `;
  withMigration(exact, (directory) => {
    const output = execFileSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.match(output, /Expand-only migration policy passed/);
  });

  for (const unsafe of [
    exact.replace("'global', 1, 2", "'global', 2, 2"),
    exact.replace('DO NOTHING', 'DO UPDATE SET "minimumWriterVersion" = 2'),
  ]) {
    withMigration(unsafe, (directory) => {
      const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Disallowed statements/);
    });
  }
});

test('expand-only policy permits only the exact terminal native-key reconciliation', () => {
  const exact = `
    UPDATE "NativeScoringRequest"
    SET "activeKey" = NULL
    WHERE status = 'failed' AND "activeKey" IS NOT NULL;
  `;
  withMigration(exact, (directory) => {
    const output = execFileSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.match(output, /Expand-only migration policy passed/);
  });

  withMigration(exact.replace("status = 'failed'", "status = 'queued'"), (directory) => {
    const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Disallowed statements/);
  });
});

test('expand-only policy allows an expression index to collect its own statistics', () => {
  withMigration(`
    CREATE INDEX IF NOT EXISTS "Job_canonicalUrl_lower_idx" ON "Job" (lower("canonicalUrl"));
    ANALYZE "Job";
  `, (directory) => {
    const output = execFileSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.match(output, /Expand-only migration policy passed/);
  });
});

test('expand-only policy does not let other maintenance in through ANALYZE', () => {
  for (const sql of ['ANALYZE;', 'VACUUM "Job";', 'VACUUM FULL "Job";', 'ANALYZE "Job" ("title");']) {
    withMigration(sql, (directory) => {
      const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, sql);
      assert.match(result.stderr, /Disallowed statements/, sql);
    });
  }
});


test('page response compatibility upgrade requires the replacement key and writer fence atomically', () => {
  const sql = readFileSync('prisma/migrations/20261117050200_ats_page_response_attempt/migration.sql', 'utf8');
  withMigration(sql, directory => {
    const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
  for (const unsafe of [
    'DROP INDEX "AtsIngestionPage_batchId_generation_requestedOffset_key";',
    sql.replace('BEGIN;', ''),
    sql.replace(/CREATE UNIQUE INDEX "AtsIngestionPage_response_attempt_key"[\s\S]*?;/, ''),
    sql.replace(/UPDATE "AtsAcquisitionRuntimeGate"[\s\S]*?;/, ''),
    sql.replaceAll('GREATEST("minimumWriterVersion", 4)', 'GREATEST("minimumWriterVersion", 5)'),
    sql.replace('WHERE id = \'global\' AND "v2AuthorityActivatedAt" IS NOT NULL', 'WHERE id = \'global\''),
  ]) withMigration(unsafe, directory => {
    const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'unsafe compatibility change was accepted');
  });
});
