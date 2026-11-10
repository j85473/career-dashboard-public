import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogueExpandedAtsBacklog } from '../../scripts/catalogue_expanded_ats_backlog';

test('a handoff larger than two pages exhausts changing eligibility without resetting an existing hold', async () => {
  const candidates = Array.from({ length: 501 }, (_, index) => ({ runId: 'run', platform: 'polymer',
    slug: `https://jobs.polymer.co/company-${String(index).padStart(4, '0')}`, sourceUrl: null, status: 'awaiting_adapter' }));
  const existingHold = { state: 'size_review', lastError: 'Reviewed hold', nextValidationAt: new Date('2099-01-01') };
  const heldBefore = structuredClone(existingHold), saved = new Map<string, object>([['company-0000', existingHold]]);
  const client = {
    atsDiscoveryAuditCandidate: {
      findMany: async (options: { cursor?: { runId_platform_slug: { slug: string } }; take: number }) => {
        // Prisma's filtered cursor cannot locate a row that was just applied.
        const eligible = candidates.filter(row => row.status === 'awaiting_adapter');
        if (options.cursor && !eligible.some(row => row.slug === options.cursor!.runId_platform_slug.slug)) return [];
        return eligible.slice(0, options.take).map(row => ({ ...row }));
      },
      updateMany: async ({ where, data }: { where: { slug: string; status: string }; data: { status: string } }) => {
        const row = candidates.find(row => row.slug === where.slug && row.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
    },
    atsCompany: { findMany: async () => [] },
    atsFirstCollectionCandidate: { upsert: async ({ create, update }: { create: { slug: string }; update: object }) => {
      assert.deepEqual(update, {});
      if (!saved.has(create.slug)) saved.set(create.slug, create);
    } },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
  };
  const result = await catalogueExpandedAtsBacklog(client as unknown as Parameters<typeof catalogueExpandedAtsBacklog>[0], true);
  assert.equal(result.catalogued, 501);
  assert.equal(candidates.filter(row => row.status === 'awaiting_adapter').length, 0);
  assert.equal(saved.size, 501);
  assert.deepEqual(existingHold, heldBefore);
  assert.equal((await catalogueExpandedAtsBacklog(client as unknown as Parameters<typeof catalogueExpandedAtsBacklog>[0], true)).catalogued, 0);
});
