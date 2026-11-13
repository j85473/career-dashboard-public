import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '../prismaClient';
import { mockPrismaTransaction } from '../../../tests/helpers/mockPrismaTransaction';
import { enrichNextAtsV2DetailItem, type AtsLedgerClaim } from '../atsAcquisitionLedger';
import { withAtsRetryReason } from '../atsRetryReason';
import { prisma } from '../prisma';

test('real detail scheduling serves untried items first and preserves failed evidence on a longer retry', async t => {
  const now = new Date('2026-11-13T19:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const claim: AtsLedgerClaim = { batchId: 'batch', slug: 'acme.wd1::External', platform: 'workday',
    workType: 'enrichment', claimToken: 'claim', claimFence: BigInt(1), workReceiptId: 'receipt', endpointSweepId: null,
    listingGeneration: 1, listingOffset: 40, latestObservedTotal: 40, acquisitionPhase: 'enrichment', segmentSize: 25 };
  const batch = { id: claim.batchId, writerMode: 'v2', ledgerVersion: 2, activeLedgerGeneration: 1,
    acquisitionClaimToken: claim.claimToken, acquisitionClaimFence: claim.claimFence,
    acquisitionLeaseExpiresAt: new Date(now.getTime() + 120_000), acquisitionPhase: 'enrichment' };
  const items = [199, 0].map((detailAttemptCount, canonicalOrdinal) => ({
    id: `item-${canonicalOrdinal}`, canonicalOrdinal, detailAttemptCount, itemClaimFence: BigInt(0),
    itemClaimToken: null as string | null, itemClaimOwner: null as string | null,
    enrichmentStatus: 'pending', enrichmentReason: 'network_required', nextDetailAt: null as Date | null,
    terminalAt: null, rawHash: `raw-${canonicalOrdinal}`,
    rawJson: { title: 'Account Manager', externalPath: `/job/Remote/Account-Manager_${canonicalOrdinal}` },
    representativeObservation: null,
  }));
  const evidence = items.map(item => structuredClone({ rawJson: item.rawJson, rawHash: item.rawHash }));
  const served: string[] = [];
  const pendingWrites: Array<Record<string, unknown>> = [];
  const itemStore = {
    findFirst: async (query: { where: { OR: unknown[]; itemClaimToken: null }; orderBy: unknown }) => {
      assert.deepEqual(query.orderBy, [{ detailAttemptCount: 'asc' }, { canonicalOrdinal: 'asc' }]);
      assert.equal(query.where.itemClaimToken, null);
      assert.deepEqual(query.where.OR, [{ nextDetailAt: null }, { nextDetailAt: { lte: now } }]);
      const item = items.filter(item => !item.itemClaimToken && (!item.nextDetailAt || item.nextDetailAt <= now))
        .sort((a, b) => a.detailAttemptCount - b.detailAttemptCount || a.canonicalOrdinal - b.canonicalOrdinal)[0];
      if (item) served.push(item.id);
      return item || null;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => items.find(item => item.id === where.id),
    updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const item = items.find(item => item.id === where.id)!;
      if (data.enrichmentStatus === 'pending') {
        pendingWrites.push(data);
        Object.assign(item, data);
      } else {
        const { detailAttemptCount, itemClaimFence, ...rest } = data;
        item.detailAttemptCount += (detailAttemptCount as { increment: number }).increment;
        item.itemClaimFence += (itemClaimFence as { increment: bigint }).increment;
        Object.assign(item, rest);
      }
      return { count: 1 };
    },
  };
  const tx = { atsIngestionBatch: { findUniqueOrThrow: async () => batch }, atsIngestionItem: itemStore };
  mockPrismaTransaction(t, prisma, async (run: (client: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient));
  const original = prisma.atsIngestionItem.updateMany;
  prisma.atsIngestionItem.updateMany = itemStore.updateMany as unknown as typeof original;
  t.after(() => { prisma.atsIngestionItem.updateMany = original; });
  const dependencies = {
    passesPreFilter: () => ({ passes: true, reason: '' }),
    reserveProviderBudgetForSource: async () => { throw withAtsRetryReason(new Error('Retained employer evidence'),
      { code: 'employer_unverified', scope: 'posting' }); },
  };
  assert.equal(await enrichNextAtsV2DetailItem({ claim, requestTimeoutMs: 1000 }, dependencies), 'deferred');
  assert.equal(await enrichNextAtsV2DetailItem({ claim, requestTimeoutMs: 1000 }, dependencies), 'deferred');
  assert.deepEqual(served, ['item-1', 'item-0']);
  assert.equal(items[1].nextDetailAt?.getTime(), now.getTime() + 15 * 60_000);
  assert.equal(items[0].nextDetailAt?.getTime(), now.getTime() + 24 * 3600_000);
  for (const item of items) {
    assert.equal(item.enrichmentStatus, 'pending');
    assert.equal(item.terminalAt, null);
    assert.equal(item.itemClaimToken, null);
  }
  assert.deepEqual(items.map(item => ({ rawJson: item.rawJson, rawHash: item.rawHash })), evidence);
  for (const data of pendingWrites) {
    assert.equal(data.retryCode, 'employer_unverified');
    assert.ok(!('rawJson' in data) && !('terminalAt' in data));
  }
});
