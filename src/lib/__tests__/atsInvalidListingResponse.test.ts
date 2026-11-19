import { mockPrismaTransaction } from '../../../tests/helpers/mockPrismaTransaction';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Prisma } from '../prismaClient';
import { prisma } from '../prisma';
import {
  atsLedgerHash, invalidAtsListingResponseOverlay, resolveNextAtsV2ObservationChunk,
  type AtsLedgerClaim,
} from '../atsAcquisitionLedger';
import {
  ATS_INVALID_PROVIDER_RESPONSE_REASON, ATS_JOB_ENRICHMENT_KEY, isWorkdayBulletFieldsOnly, readAtsJobEnrichmentMarker,
} from '../atsJobEnrichment';

const empty = { rawJson: {}, rawHash: atsLedgerHash({}), providerSourceId: null };
const bulletFields = { bulletFields: ['R123', 'Posted 4 Days Ago'] };
const fragment = { rawJson: bulletFields, rawHash: atsLedgerHash(bulletFields), providerSourceId: null };

test('only the original hash-proven empty response receives an invalid disposition', () => {
  const now = new Date('2026-10-06T15:00:00Z');
  const overlay = invalidAtsListingResponseOverlay(empty, 'workday', now);
  const marker = readAtsJobEnrichmentMarker(overlay!);
  assert.equal(marker?.reason, ATS_INVALID_PROVIDER_RESPONSE_REASON);
  assert.equal(marker?.attempted, false);
  for (const observation of [
    { ...empty, rawJson: null }, { ...empty, rawJson: [] },
    { ...empty, rawHash: atsLedgerHash({ title: 'lost content' }) },
    { ...empty, providerSourceId: 'known-job' },
    { ...empty, rawJson: { title: 'existing content' } },
  ]) assert.equal(invalidAtsListingResponseOverlay(observation, 'workday', now), null);
});

test('only a source-verified Workday bullet fragment can be recorded as invalid', () => {
  const now = new Date('2026-11-19T18:52:00Z');
  const overlay = invalidAtsListingResponseOverlay(fragment, 'workday', now);
  const marker = readAtsJobEnrichmentMarker(overlay);
  assert.equal(marker?.reason, ATS_INVALID_PROVIDER_RESPONSE_REASON);
  assert.equal(invalidAtsListingResponseOverlay(fragment, 'oracle', now), null);
  assert.equal(invalidAtsListingResponseOverlay({ ...fragment, providerSourceId: 'known-job' }, 'workday', now), null);
  assert.equal(invalidAtsListingResponseOverlay({ ...fragment, rawHash: empty.rawHash }, 'workday', now), null);
  for (const rawJson of [
    { ...bulletFields, title: 'Account Manager' }, { ...bulletFields, externalPath: '/job/Account-Manager_R123' },
    { ...bulletFields, newVendorField: 'Potential posting evidence' }, { bulletFields: [{ text: 'Unexpected format' }] },
  ]) {
    assert.equal(invalidAtsListingResponseOverlay({ ...fragment, rawJson, rawHash: atsLedgerHash(rawJson) }, 'workday', now), null);
  }
  const retainedMarker = { ...marker!, reason: 'missing_detail_identity' };
  const retained = { ...bulletFields, [ATS_JOB_ENRICHMENT_KEY]: retainedMarker };
  assert.equal(isWorkdayBulletFieldsOnly(retained, readAtsJobEnrichmentMarker(retained)), true);
  assert.equal(isWorkdayBulletFieldsOnly(retained), false, 'the source shape may not claim a ledger marker');
  assert.equal(isWorkdayBulletFieldsOnly({ ...retained, title: 'Account Manager' }, retainedMarker), false);
  assert.equal(isWorkdayBulletFieldsOnly({ ...retained, externalPath: '/job/Account-Manager_R123' }, retainedMarker), false);
});

function fixture(t: TestContext, invalid: { rawJson: object; rawHash: string; providerSourceId: null } = empty) {
  const claim: AtsLedgerClaim = {
    batchId: 'batch', slug: 'freudenberg.wd3::freudenberg-group', platform: 'workday',
    workType: 'compaction', claimToken: 'claim', claimFence: BigInt(1),
    workReceiptId: 'receipt', endpointSweepId: null, listingGeneration: 1,
    listingOffset: 2, latestObservedTotal: 2, acquisitionPhase: 'compaction', segmentSize: 25,
  };
  const batch = {
    id: claim.batchId, slug: claim.slug, platform: claim.platform,
    writerMode: 'v2', ledgerVersion: 2, activeLedgerGeneration: 1,
    acquisitionClaimToken: claim.claimToken, acquisitionClaimFence: claim.claimFence,
    acquisitionLeaseExpiresAt: new Date(Date.now() + 60_000), acquisitionPhase: 'compaction',
    rawObservationCount: 2, canonicalOccurrenceCount: 0, compactedOccurrenceCount: 0,
  };
  const valid = { title: 'Channel Manager', externalPath: '/job/Channel-Manager_R123' };
  const observations = [
    { id: 'invalid', ...structuredClone(invalid) },
    { id: 'valid', rawJson: valid, rawHash: atsLedgerHash(valid), providerSourceId: 'R123' },
  ];
  const items: Prisma.AtsIngestionItemCreateManyInput[] = [];
  const resolutions: Prisma.AtsListingObservationResolutionCreateManyInput[] = [];
  const updates: Record<string, unknown>[] = [];
  const receipts: Record<string, unknown>[] = [];
  const tx = {
    $queryRaw: async () => [],
    atsIngestionBatch: {
      findUniqueOrThrow: async () => batch,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data); Object.assign(batch, data);
      },
    },
    atsListingObservation: { findMany: async () => observations.filter(o => !resolutions.some(r => r.observationId === o.id)) },
    atsIngestionItem: { createMany: async ({ data }: { data: typeof items }) => { items.push(...data); } },
    atsListingObservationResolution: { createMany: async ({ data }: { data: typeof resolutions }) => { resolutions.push(...data); } },
    atsAcquisitionWorkReceipt: { update: async ({ data }: { data: Record<string, unknown> }) => { receipts.push(data); } },
  };
  mockPrismaTransaction(t, prisma, async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => run(tx as unknown as Prisma.TransactionClient));
  return { claim, batch, observations, items, resolutions, updates, receipts };
}

test('a Workday bullet fragment remains auditable while valid work advances, without duplicate or replay inflation', async t => {
  const f = fixture(t, fragment);
  const original = structuredClone(f.observations);
  assert.deepEqual(await resolveNextAtsV2ObservationChunk({ claim: f.claim }), {
    resolved: 2, retained: 2, compacted: 0, complete: true,
  });
  assert.deepEqual(f.observations, original, 'the immutable source must never be rewritten');
  assert.equal(f.items[0].enrichmentStatus, 'terminal');
  assert.equal(f.items[0].enrichmentReason, ATS_INVALID_PROVIDER_RESPONSE_REASON);
  assert.ok(f.items[0].terminalAt instanceof Date);
  assert.equal(f.items[0].rawJson, Prisma.DbNull);
  assert.deepEqual(f.items[0].rawReference, {
    version: 1, type: 'observation', observationId: f.observations[0].id, rawHash: fragment.rawHash,
  }, 'the fragment remains recoverable from its unchanged observation');
  assert.equal(f.items[1].enrichmentStatus, undefined, 'valid work remains available for enrichment');
  assert.equal(f.resolutions[0].resolutionType, ATS_INVALID_PROVIDER_RESPONSE_REASON);
  assert.equal(f.resolutions[1].resolutionType, 'canonical_item');
  assert.equal(f.batch.canonicalOccurrenceCount + f.batch.compactedOccurrenceCount, f.batch.rawObservationCount);
  assert.deepEqual(f.updates[0].terminalItemCount, { increment: 1 });
  assert.deepEqual(f.receipts[0].itemsTerminalized, { increment: 1 });
  await resolveNextAtsV2ObservationChunk({ claim: f.claim });
  assert.equal(f.items.length, 2);
  assert.equal(f.resolutions.length, 2);
  assert.equal(f.receipts.length, 1);
});

test('lost nonempty content still stops the batch before any ledger writes', async t => {
  const f = fixture(t);
  f.observations[0].rawHash = atsLedgerHash({ title: 'lost' });
  await assert.rejects(resolveNextAtsV2ObservationChunk({ claim: f.claim }), /without materialized JSON/);
  assert.equal(f.items.length + f.resolutions.length + f.updates.length, 0);
});

test('an expired or replaced worker cannot dispose of an empty response', async t => {
  const f = fixture(t);
  await assert.rejects(resolveNextAtsV2ObservationChunk({ claim: { ...f.claim, claimFence: BigInt(2) } }), /no longer owns/);
  assert.equal(f.items.length + f.resolutions.length + f.updates.length, 0);
});
