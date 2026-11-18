import assert from 'node:assert/strict';
import test from 'node:test';
import { JobUrlConflict, lockJobUrlEdits, reconcileJobUrlEdit } from '../../src/lib/jobUrlReconciliation';
import { createPrismaAdapter } from '../../src/lib/prismaAdapter';
import { PrismaClient } from '../../src/lib/prismaClient';

// Apply repository migrations to a disposable local database before running.
const databaseUrl = process.env.JOB_URL_RECONCILIATION_TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== '127.0.0.1'
  || new URL(databaseUrl).pathname !== '/career_job_url_verify') {
  throw Error('Set JOB_URL_RECONCILIATION_TEST_DATABASE_URL to the local career_job_url_verify database.');
}

test('indexed link reconciliation finds old URL variants and preserves scores', async () => {
  const db = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
  const rollback = new Error('Roll back test fixtures');
  const prefix = 'https://jobs.lever.co/example%20_team/e2d946b2-c0e5-4f58-81a4-fb6ce844a114';
  const submitted = `${prefix}?utm_source=manual#description`;
  const legacy = `${prefix.toUpperCase()}/APPLY?source=existing`;
  const differentOpening = `${prefix}6`;
  const defaults = {
    title: 'Partner Success Manager',
    company: 'Example',
    location: 'Remote',
    postedAt: new Date('2025-01-01'),
    createdAt: new Date('2025-01-01'),
    aimFitScore: 90,
    reqFitScore: 85,
    scoringStatus: 'scored',
  };

  try {
    await assert.rejects(db.$transaction(async tx => {
      const edited = await tx.job.create({ data: { ...defaults, status: 'inbox', description: 'Saved description' } });
      const other = await tx.job.create({ data: { ...defaults, status: 'applied', url: differentOpening } });
      const duplicate = await tx.job.create({ data: { ...defaults, status: 'applied', canonicalUrl: legacy } });
      const input = { id: edited.id, url: submitted, expectedUpdatedAt: edited.updatedAt, allowConsolidation: false };
      const isDuplicate = (error: unknown) => error instanceof JobUrlConflict
        && error.mergeTargetJobId === duplicate.id;
      await lockJobUrlEdits(tx);

      await assert.rejects(reconcileJobUrlEdit(tx, input), isDuplicate);
      await tx.job.update({ where: { id: duplicate.id }, data: { canonicalUrl: null, url: legacy } });
      await assert.rejects(reconcileJobUrlEdit(tx, input), isDuplicate);

      await tx.job.delete({ where: { id: duplicate.id } });
      const { job } = await reconcileJobUrlEdit(tx, input);
      assert.equal(job.userCanonicalUrl, submitted);
      assert.equal(job.url, submitted);
      assert.equal(job.canonicalUrl, submitted);
      for (const key of ['status', 'scoringStatus', 'description', 'aimFitScore', 'reqFitScore'] as const) {
        assert.equal(job[key], edited[key]);
      }
      assert.deepEqual(await tx.job.findUnique({ where: { id: other.id } }), other);
      throw rollback;
    }), error => error === rollback);
  } finally {
    await db.$disconnect();
  }
});
