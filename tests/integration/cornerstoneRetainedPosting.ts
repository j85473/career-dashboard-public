/** Run on a fresh disposable local database with the current Prisma schema. */
import assert from 'node:assert/strict';
import { prisma } from '../../src/lib/prisma';
import { enrichNextAtsV2DetailItem, atsLedgerHash, type AtsLedgerClaim } from '../../src/lib/atsAcquisitionLedger';
import { readAtsJobEnrichmentMarker, type AtsJobEnrichmentDependencies } from '../../src/lib/atsJobEnrichment';

async function main() {
  const database = new URL(process.env.DATABASE_URL || '');
  assert.equal(database.hostname, '127.0.0.1');
  assert.equal(database.port, '55449');
  assert.equal(database.pathname, '/ats_cornerstone_repair_test');
  const now = new Date(), future = new Date(+now + 3600_000), past = new Date(+now - 3600_000);
  const slug = 'fixture.csod.com::4::default', platform = 'cornerstone';
  const board = await prisma.atsCompany.create({ data: { slug, platform, checkDay: 2, status: 'parked', nextCheckDate: future } });
  const batch = await prisma.atsIngestionBatch.create({ data: { slug, platform, writerMode: 'v2', ledgerVersion: 2,
    status: 'partial', acquisitionPhase: 'enrichment', nextAcquireAt: past, acquisitionClaimToken: 'fixture-claim',
    acquisitionClaimFence: BigInt(1), acquisitionLeaseExpiresAt: future, rawObservationCount: 3 } });
  const receipt = await prisma.atsAcquisitionWorkReceipt.create({ data: { batchId: batch.id, workType: 'enrichment' } });
  const claim: AtsLedgerClaim = { batchId: batch.id, slug, platform, workType: 'enrichment', claimToken: 'fixture-claim',
    claimFence: BigInt(1), workReceiptId: receipt.id, endpointSweepId: null, listingGeneration: 0, listingOffset: 0,
    latestObservedTotal: 3, acquisitionPhase: 'enrichment', segmentSize: 25 };
  const raw = (id: number) => ({ id: `${slug}::${id}`, publicAtsPostingId: String(id), title: 'Channel Manager',
    url: `https://fixture.csod.com/ux/ats/careersite/4/home/requisition/${id}`, company: '', location: 'Austin, TX, US', description: '<p>Listing excerpt.</p>' });
  const items = [];
  for (let index = 0; index < 3; index++) items.push(await prisma.atsIngestionItem.create({ data: {
    batchId: batch.id, canonicalOrdinal: index, rawJson: raw(123 + index), rawHash: atsLedgerHash(raw(123 + index)),
    enrichmentStatus: 'pending', enrichmentReason: 'network_required', detailAttemptCount: 14,
    retryCode: 'posting_mismatch', retryScope: 'posting', detailError: 'Cornerstone exact posting lacks unique structured evidence',
    nextDetailAt: index === 1 ? future : past,
  } }));
  const protectedJob = await prisma.job.create({ data: { title: 'Existing scored role', company: 'Fixture', status: 'interviewing',
    postedAt: now, aimFitScore: 93, fitScore: 87 } });
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ corp: 'fixture', exp: 4102444800 })).toString('base64url')}.signature`;
  const legacy = (fields: unknown) => Response.json({ status: 200, totalRecords: 1, data: [{ items: [{ fields }] }] });
  const dependencies: Partial<AtsJobEnrichmentDependencies> = {
    safeExternalFetch: async (input, init) => {
      const target = new URL(String(input));
      const id = target.pathname.match(/(?:requisition|requisitions|JobRequisition|JobRequisitions)\/(\d+)/)?.[1];
      assert.ok(id);
      if (target.pathname.startsWith('/ux/')) return new Response(`<meta property="og:title" content="Channel Manager"><script>
        var csodPlayerRouteInfo={"cid":"4","routeInfo":{"reqid":"${id}"}};
        csod.context=${JSON.stringify({ corp: 'fixture', user: -1, cultureID: 1, cultureName: 'en-US', token, endpoints: { cloud: 'https://us.api.csod.com/' } })};</script>`);
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`);
      assert.equal(init?.redirect, 'error');
      if (target.pathname.endsWith('GetRequisitionApplyStatus')) return legacy({ applyStatus: 2 });
      if (target.pathname.includes('/career-site/')) return Response.json({ status: 0, data: { postings: [{ careerSiteId: 4,
        postingUrl: raw(Number(id)).url, startDate: '2020-01-01T00:00:00', endDate: null }] } });
      if (target.pathname.endsWith('jobDetails')) return Response.json({ status: 0, data: { displayTitle: 'Channel Manager', ref: `req${id}`,
        allowApply: true, requisitionStatusId: 2, availableCultures: [1], defaultCultureId: 1,
        primaryLocation: { city: 'Austin', state: 'TX', country: 'US' }, additionalLocations: [] } });
      return legacy({ id: Number(id), reqId: `req${id}`, title: 'Channel Manager',
        ad: `<p>Employer: Verified Manufacturer</p>${id === '125' ? '<p>Employer: Conflicting Employer</p>' : ''}<p>Manage distributor accounts and develop the partner channel. Work with sales teams to support territory growth and account planning.</p>` });
    },
    fetchPlatformResponse: async (_p, _s, dispatch, options) => { const response = await dispatch(); await options?.onResponse?.(response); return response; },
    reserveProviderBudgetForSource: async () => ({ allowed: true }), recordProviderSuccess: async () => {},
    recordProviderFailure: async () => { assert.fail('Posting evidence must not open a provider circuit'); },
    createDeferredError: () => Object.assign(new Error('Retain for retry'), { name: 'AtsPlatformDeferredError' }),
    passesPreFilter: () => ({ passes: true, reason: '' }),
  };
  assert.equal(await enrichNextAtsV2DetailItem({ claim, requestTimeoutMs: 1000 }, dependencies), 'terminal');
  const completed = await prisma.atsIngestionItem.findUniqueOrThrow({ where: { id: items[0].id } });
  assert.equal(completed.enrichmentStatus, 'terminal');
  assert.equal(completed.retryCode, null);
  assert.equal(completed.detailError, null);
  assert.deepEqual(completed.rawJson, items[0].rawJson);
  assert.equal(completed.rawHash, items[0].rawHash);
  assert.equal(readAtsJobEnrichmentMarker(completed.enrichmentOverlay)?.company, 'Verified Manufacturer');
  assert.equal(await enrichNextAtsV2DetailItem({ claim, requestTimeoutMs: 1000 }, dependencies), 'deferred');
  const ambiguous = await prisma.atsIngestionItem.findUniqueOrThrow({ where: { id: items[2].id } });
  assert.equal(ambiguous.enrichmentStatus, 'pending');
  assert.equal(ambiguous.retryCode, 'employer_unverified');
  assert.equal(ambiguous.enrichmentOverlay, null);
  assert.deepEqual(ambiguous.rawJson, items[2].rawJson);
  assert.deepEqual(await prisma.atsIngestionItem.findUnique({ where: { id: items[1].id } }), items[1], 'future retry remains untouched');
  assert.deepEqual(await prisma.atsCompany.findUnique({ where: { slug_platform: { slug, platform } } }), board);
  assert.deepEqual(await prisma.job.findUnique({ where: { id: protectedJob.id } }), protectedJob);
  const afterBatch = await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: batch.id } });
  assert.deepEqual(afterBatch.nextAcquireAt, past);
  assert.equal(afterBatch.terminalItemCount, 1);
  assert.equal((await prisma.atsAcquisitionWorkReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).detailRequestCount, 10);
  console.log('Saved posting advanced through the existing ledger; raw evidence, future retries, board schedule and scores preserved; ambiguous employer remains pending.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
