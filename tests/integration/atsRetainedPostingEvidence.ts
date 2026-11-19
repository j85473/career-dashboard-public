/** Verify exact evidence lookup against an empty, disposable PostgreSQL database. */
import assert from 'node:assert/strict';
import { ATS_JOB_ENRICHMENT_KEY, ATS_JOB_ENRICHMENT_VERSION } from '../../src/lib/atsJobEnrichment';
import { atsLedgerHash } from '../../src/lib/atsEvidenceHash';
import { readNewerAtsPostingEmployerEvidence } from '../../src/lib/atsRetainedPostingEvidence';
import { Prisma } from '../../src/lib/prismaClient';
import { prisma } from '../../src/lib/prisma';

async function main() {
  const database = new URL(process.env.DATABASE_URL || '');
  assert.equal(database.hostname, '127.0.0.1');
  assert.equal(database.port, '55447');
  assert.equal(database.pathname, '/career_capacity_fixtures_proof');
  assert.equal(await prisma.atsIngestionBatch.count(), 0);
  const now = new Date();
  const day = 86_400_000;

  for (const [platform, slug, url, postingId] of [
    ['oracle', 'fixture.fa.us2.oraclecloud.com::CX', 'https://fixture.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1001', '1001'],
    ['ukg', 'recruiting2.ultipro.com::FIXTURE::6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b',
      'https://recruiting2.ultipro.com/FIXTURE/JobBoard/6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b/OpportunityDetail?opportunityId=14ce5fe4-5d06-404d-8583-000000000001',
      '14ce5fe4-5d06-404d-8583-000000000001'],
  ] as const) {
    const board = { platform, slug };
    await prisma.atsCompany.create({ data: { ...board, acquisitionEngine: 'v2', checkDay: 0 } });
    const raw = { id: `${slug}::${postingId}`, publicAtsPostingId: postingId, title: 'Account Manager', url };
    const createBatch = (daysAgo: number) => prisma.atsIngestionBatch.create({ data: {
      ...board, createdAt: new Date(+now - daysAgo * day), writerMode: 'v2', activeLedgerGeneration: 1, status: 'synchronized',
    } });
    const original = await createBatch(20);
    const recent = await createBatch(1);
    const stale = await createBatch(16);
    const marker = (company: string) => ({
      [ATS_JOB_ENRICHMENT_KEY]: { version: ATS_JOB_ENRICHMENT_VERSION, platform, detailSource: `ATS-${platform} Details`,
        status: 'enriched', attempted: true, completedAt: now.toISOString(), company, location: 'Minneapolis, MN',
        description: 'Newer description', compensation: null },
    });
    const olderItem = await prisma.atsIngestionItem.create({ data: {
      batchId: original.id, ledgerGeneration: 1, canonicalOrdinal: 0, rawJson: raw,
      rawHash: atsLedgerHash(raw), providerSourceId: raw.id, enrichmentStatus: 'terminal',
    } });
    await prisma.atsIngestionItem.create({ data: {
      batchId: stale.id, ledgerGeneration: 1, canonicalOrdinal: 0, rawJson: raw, rawHash: atsLedgerHash(raw),
      providerSourceId: raw.id, enrichmentStatus: 'terminal', enrichmentVersion: 1, enrichmentOverlay: marker('Stale Employer'),
    } });
    const read = (job: Record<string, unknown> = raw) => readNewerAtsPostingEmployerEvidence(platform, slug, original.id, job);
    assert.equal(await read(), null);

    const page = await prisma.atsIngestionPage.create({ data: {
      batchId: recent.id, generation: 1, requestedOffset: 0, requestedLimit: 1,
      responseItemCount: 1, responseHash: 'fixture', identityMultisetHash: 'fixture',
      requestedAt: now, respondedAt: now, httpStatus: 200,
    } });
    const observation = await prisma.atsListingObservation.create({ data: {
      batchId: recent.id, pageId: page.id, generation: 1, pageOrdinal: 0,
      providerSourceId: raw.id, rawJson: raw, rawHash: atsLedgerHash(raw), observedAt: now,
    } });
    const item = await prisma.atsIngestionItem.create({ data: {
      batchId: recent.id, ledgerGeneration: 1, canonicalOrdinal: 0,
      providerSourceId: raw.id, enrichmentStatus: 'terminal', enrichmentVersion: 1, enrichmentOverlay: marker('Verified Employer'),
      representativeObservationId: observation.id, rawHash: observation.rawHash,
      rawReference: { version: 1, type: 'observation', observationId: observation.id, rawHash: observation.rawHash },
    } });
    assert.deepEqual(await read(), { company: 'Verified Employer', description: null, location: 'Minneapolis, MN' });
    assert.equal(await read({ ...raw, title: 'Changed Account Manager' }), null);
    assert.equal(await read({ ...raw, publicAtsPostingId: 'different' }), null);
    assert.equal(await read({ ...raw, url: `${url}${url.includes('?') ? '&' : '?'}changed=1` }), null);
    assert.deepEqual(await prisma.atsIngestionItem.findUnique({ where: { id: olderItem.id } }), olderItem);

    const conflict = await prisma.atsIngestionItem.create({ data: {
      batchId: recent.id, ledgerGeneration: 1, canonicalOrdinal: 1, rawJson: raw, rawHash: atsLedgerHash(raw),
      providerSourceId: raw.id, enrichmentStatus: 'terminal', enrichmentVersion: 1, enrichmentOverlay: marker('Conflicting Employer'),
    } });
    assert.equal(await read(), null);
    await prisma.atsIngestionItem.update({ where: { id: conflict.id }, data: { enrichmentOverlay: Prisma.DbNull } });
    await prisma.atsIngestionItem.update({ where: { id: item.id }, data: { ledgerGeneration: 2 } });
    assert.equal(await read(), null);
  }
  console.log('Verified exact Oracle and UKG evidence reuse, stale and conflicting proof rejection, and unchanged older items.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
