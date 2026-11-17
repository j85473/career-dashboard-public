/** Isolated PostgreSQL fixture only. Prepare an EMPTY local database with the
 * current schema except AtsIngestionPage.responseAttempt and its four-part key;
 * retain the former three-part unique key. This fixture applies the real upgrade
 * over a saved legacy anomaly and installs the original immutable-page trigger.
 * DATABASE_URL must name career_capacity_fixtures_page_repair* on127.0.0.1:55447.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { prisma } from '../../src/lib/prisma';
import { Prisma } from '../../src/lib/prismaClient';
import { commitAtsV2ListingPage, readAtsV2ListingCheckpoint, type AtsLedgerClaim } from '../../src/lib/atsAcquisitionLedger';
import { validateAtsAcquisitionWriterCompatibility } from '../../src/lib/atsAcquisitionCompatibility';

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55447');
  assert.match(url.pathname, /^\/career_capacity_fixtures_page_repair\d*$/);
  assert.equal(await prisma.atsCompany.count(), 0, 'Use a new empty fixture database');
  const sql = new Client({ connectionString: url.href });
  await sql.connect();
  try {
    await sql.query("SET TIME ZONE 'America/Chicago'");
    const protectedJob = await prisma.job.create({ data: { title: 'Preserved candidate job', company: 'Fixture employer',
      postedAt: new Date(), status: 'interviewing', fitScore: 87, aimFitScore: 93, description: 'Original description' } });
    const historical = readFileSync('prisma/migrations/20260830213000_ats_acquisition_ledger_phase2_runtime/migration.sql', 'utf8');
    await sql.query(historical.slice(historical.indexOf('CREATE FUNCTION "guard_ats_ingestion_page_evidence"'),
      historical.indexOf('CREATE FUNCTION "reject_ats_append_only_evidence_change"')));
    const migration = readFileSync('prisma/migrations/20261117050200_ats_page_response_attempt/migration.sql', 'utf8');
    await prisma.atsAcquisitionRuntimeGate.create({ data: { id: 'global', minimumWriterVersion: 1, compatibilityWriterVersion: 2 } });
    // Prove the migration does not silently activate an inactive installation.
    const gateUpdate = migration.indexOf('UPDATE "AtsAcquisitionRuntimeGate"');
    await sql.query(migration.slice(gateUpdate, migration.indexOf(';', gateUpdate) + 1));
    let gate = await prisma.atsAcquisitionRuntimeGate.findUniqueOrThrow({ where: { id: 'global' } });
    assert.equal(gate.minimumWriterVersion, 1); assert.equal(gate.v2AuthorityActivatedAt, null);
    await prisma.atsAcquisitionRuntimeGate.update({ where: { id: 'global' }, data: {
      minimumWriterVersion: 3, compatibilityWriterVersion: 3, v2AuthorityActivatedAt: new Date(), activatedLedgerVersion: 2,
    } });

    async function claim(slug: string): Promise<AtsLedgerClaim> {
      const token = randomUUID();
      await prisma.atsCompany.create({ data: { slug, platform: 'workday', acquisitionEngine: 'v2', checkDay: 0 } });
      const batch = await prisma.atsIngestionBatch.create({ data: { slug, platform: 'workday',
        writerMode: 'v2', ledgerVersion: 2, activeLedgerGeneration: 1, listingGeneration: 1,
        acquisitionPhase: 'listing', status: 'fetching', acquisitionClaimToken: token,
        acquisitionClaimFence: BigInt(1), acquisitionLeaseExpiresAt: new Date(Date.now() + 600000) } });
      const receipt = await prisma.atsAcquisitionWorkReceipt.create({ data: { batchId: batch.id,
        workType: 'coverage_listing', leaseToken: token, leaseFence: BigInt(1) } });
      return { batchId: batch.id, slug, platform: 'workday', workType: 'coverage_listing',
        claimToken: token, claimFence: BigInt(1), workReceiptId: receipt.id, endpointSweepId: null,
        listingGeneration: 1, listingOffset: 0, latestObservedTotal: null, acquisitionPhase: 'listing', segmentSize: 25 };
    }
    const legacy = await claim('legacy-empty');
    await sql.query(`INSERT INTO "AtsIngestionPage" (id,"batchId",generation,"requestedOffset","requestedLimit",
      "providerTotal","responseItemCount","responseHash","identityMultisetHash",metadata,"requestedAt","respondedAt",
      "httpStatus","materializationCompleteAt") VALUES ($1,$2,1,0,20,3,0,'legacy-empty-hash','legacy-identities','{}',now(),now(),200,now())`,
    [randomUUID(), legacy.batchId]);
    const old = (await sql.query('SELECT to_jsonb(page) AS evidence FROM "AtsIngestionPage" page WHERE "batchId"=$1', [legacy.batchId])).rows[0].evidence;
    await sql.query(migration);
    gate = await prisma.atsAcquisitionRuntimeGate.findUniqueOrThrow({ where: { id: 'global' } });
    assert.equal(gate.minimumWriterVersion, 4); assert.equal(gate.compatibilityWriterVersion, 4);
    // This is the prior version-3 validator's actual decision, independent of
    // the new default constant: older than durable minimum => refuse startup.
    const oldWriterMayRun = !(3 < gate.minimumWriterVersion)
      && !(gate.v2AuthorityActivatedAt && 3 < gate.compatibilityWriterVersion);
    assert.equal(oldWriterMayRun, false);
    assert.equal(validateAtsAcquisitionWriterCompatibility(gate, 3).valid, false);
    assert.equal(validateAtsAcquisitionWriterCompatibility(gate).valid, true);

    const commit = (owner: AtsLedgerClaim, jobs: Record<string, unknown>[], total: number, complete = false,
      metadata: Record<string, unknown> = {}) =>
      commitAtsV2ListingPage({ claim: owner, requestedOffset: 0, requestedLimit: 20, providerTotal: total,
        jobs, metadata, requestedAt: new Date(), respondedAt: new Date(), httpStatus: 200, listingComplete: complete });
    const recovered = await Promise.all([
      commit(legacy, [{ externalPath: '/job1' }], 3, false, { receipt: 'corrected' }),
      commit(legacy, [{ externalPath: '/job1' }], 3, false, { receipt: 'corrected' }),
    ]);
    assert.equal(recovered.filter(result => result.adopted).length, 1, 'concurrent replay appends exactly once');
    let pages = await prisma.atsIngestionPage.findMany({ where: { batchId: legacy.batchId }, orderBy: { responseAttempt: 'asc' } });
    assert.equal(pages.length, 2); assert.equal(pages[0].responseAttempt, 0); assert.equal(pages[1].responseAttempt, 1);
    const preserved = (await sql.query(`SELECT to_jsonb(page)-'responseAttempt' AS evidence
      FROM "AtsIngestionPage" page WHERE id=$1`, [pages[0].id])).rows[0].evidence;
    assert.deepEqual(preserved, old, 'all original evidence values must survive exactly');
    assert.equal((await readAtsV2ListingCheckpoint(legacy)).latestPage?.id, pages[1].id,
      'restart must select the corrected response at the same offset');
    assert.deepEqual((await readAtsV2ListingCheckpoint(legacy)).latestPage?.metadata, { receipt: 'corrected' });
    assert.equal(await prisma.atsListingObservation.count({ where: { batchId: legacy.batchId } }), 1);
    const recoveredBatch = await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: legacy.batchId } });
    assert.equal(recoveredBatch.listingOffset, 1);
    assert.equal(recoveredBatch.rawObservationCount, 1);
    assert.equal(pages.reduce((total, page) => total + page.responseItemCount, 0), 1, 'empty attempts add no observations');
    await assert.rejects(commit(legacy, [{ externalPath: '/different' }], 3), /changed after it was committed/);
    await assert.rejects(prisma.atsIngestionPage.update({ where: { id: pages[0].id }, data: { responseAttempt: 2 } }), /attempts are immutable/);
    await assert.rejects(prisma.atsIngestionPage.update({ where: { id: pages[0].id }, data: { responseHash: 'rewritten' } }), /evidence cannot be rewritten/);

    const ordinary = await claim('ordinary-nonempty');
    const ordinaryPage = await commit(ordinary, [{ externalPath: '/ordinary' }], 2);
    const saved = await prisma.atsIngestionPage.findUniqueOrThrow({ where: { id: ordinaryPage.pageId } });
    await assert.rejects(prisma.atsIngestionPage.create({ data: { ...saved, id: randomUUID(), responseAttempt: 1,
      metadata: saved.metadata === null ? Prisma.DbNull : saved.metadata as Prisma.InputJsonValue,
      rawBody: saved.rawBody === null ? Prisma.DbNull : saved.rawBody as Prisma.InputJsonValue,
    } }), /incomplete empty response/);

    const fresh = await claim('new-empty');
    await commit(fresh, [], 2);
    assert.equal((await commit(fresh, [], 2)).adopted, true, 'same empty evidence is not duplicated');
    assert.equal(await prisma.atsIngestionPage.count({ where: { batchId: fresh.batchId } }), 1);
    await assert.rejects(commit({ ...fresh, claimFence: BigInt(2) }, [{ externalPath: '/stale' }], 2), /no longer owns/);
    await commit(fresh, [], 4);
    await commit(fresh, [], 0, true);
    pages = await prisma.atsIngestionPage.findMany({ where: { batchId: fresh.batchId }, orderBy: { responseAttempt: 'asc' } });
    assert.equal(pages.length, 3);
    assert.equal((await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: fresh.batchId } })).acquisitionPhase, 'compaction');
    assert.deepEqual(pages.map(page => page.providerTotal), [2, 4, 0]);
    const competing = await claim('competing-recovery');
    await commit(competing, [], 2);
    const disputed = await Promise.allSettled([
      commit(competing, [{ externalPath: '/winner-a' }], 2),
      commit(competing, [{ externalPath: '/winner-b' }], 2),
    ]);
    assert.equal(disputed.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = disputed.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && /changed after it was committed/.test(String(rejected.reason)));
    assert.equal(await prisma.atsIngestionPage.count({ where: { batchId: competing.batchId } }), 2);
    assert.deepEqual(await prisma.job.findUniqueOrThrow({ where: { id: protectedJob.id } }), protectedJob);
    console.log('PASS: legacy empty-page recovery; append-only evidence; one concurrent retry; restart checkpoint; stale fence; nonempty divergence; immutable attempt; inactive gate; writer-3 rollback fence');
  } finally { await sql.end(); }
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
