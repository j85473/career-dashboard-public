/** Disposable local PostgreSQL only. Create an empty career_capacity_fixtures_browser*
 * database on 127.0.0.1:55447, install pg_trgm, then apply the current schema.
 * DATABASE_URL=postgresql://capacity_test@127.0.0.1:55447/career_capacity_fixtures_browser_repair2
 * node --import tsx tests/integration/browserAtsDetailRecovery.ts
 */
import assert from 'node:assert/strict';
import { prisma } from '../../src/lib/prisma';
import { Prisma } from '../../src/lib/prismaClient';
import { saveBrowserSweepProgress, settleBrowserDetailRetry } from '../../src/lib/browserAtsDetailRecovery';
import { readCrawlQueueHeads } from '../../src/lib/atsCrawlingSchedule';
import { readAtsQueueTelemetry } from '../../src/lib/atsQueueTelemetry';
import { advanceBrowserSweep, loadBrowserSweepPage, newBrowserSweep, type BrowserSweepProgress } from '../../src/lib/browserAtsProgress';
import { browserPostingLink } from '../../src/lib/browserAtsPosting';
import { listingSignature } from '../../src/lib/browserAtsReader';
import { runBrowserAtsWorker } from '../../src/lib/browserAtsWorker';
import { browserAtsTaskDefinition } from '../../src/lib/ingestionTaskCatalog';
import { seedIngestionTaskSpecs } from '../../src/lib/ingestionControl';

async function completeWorkerRegression(past: Date) {
    const platform = 'avature' as const, slug = 'https://worker-example.avature.net/careers/SearchJobs';
    await seedIngestionTaskSpecs([browserAtsTaskDefinition(platform).spec], { now: past });
    await prisma.atsCompany.create({ data: { slug, platform, checkDay: 0, nextCheckDate: past } });
    const failed = browserPostingLink(platform, slug, '/careers/JobDetail/Account-Manager/1', 'Account Manager')!;
    const generic = browserPostingLink(platform, slug, '/careers/JobDetail/General-Application/2', 'General Application')!;
    const initial = loadBrowserSweepPage(newBrowserSweep(slug), { links: [failed, generic], total: 3,
        signature: listingSignature([failed, generic]), next: { kind: 'url', url: slug + '?jobOffset=2' } });
    initial.transport = 'browser-v1';
    await prisma.atsBrowserSweep.create({ data: { slug, platform, status: 'partial', cursor: initial as unknown as Prisma.InputJsonValue } });
    let closed = false;
    const visited: string[] = [];
    const none = { count: async () => 0, nth() { return this; }, filter() { return this; } };
    const context = { newPage: async () => {
        let current = slug;
        const frame = { url: () => current, content: async () => current.includes('SearchJobs')
            ? '<a href="/careers/JobDetail/General-Application/3">General Application</a>' : '<h1>Account Manager</h1>',
            locator: (selector: string) => selector === 'body' ? { innerText: async () => current.includes('SearchJobs') ? '3 Results' : 'Account Manager' } : none,
            getByRole: () => none };
        return { goto: async (url: string) => { current = url; visited.push(url); return { status: () => closed && url.includes('JobDetail') ? 404 : 200 }; },
            url: () => current, frames: () => [frame], locator: frame.locator, getByRole: () => none,
            waitForTimeout: async () => {}, close: async () => {} };
    } };
    const options = { platforms: [platform], boards: [slug], context: context as never, maxProviders: 1, budgetMs: 10000 };
    await runBrowserAtsWorker(options);
    assert.ok(visited.includes(slug + '?jobOffset=2'), 'real worker reaches the later listing despite a failed detail');
    const listed = await prisma.atsBrowserSweep.findUniqueOrThrow({ where: { slug_platform: { slug, platform } } });
    assert.equal(listed.status, 'listed');
    assert.deepEqual((listed.cursor as unknown as BrowserSweepProgress).deferredDetailIds, ['1']);
    assert.equal((await prisma.atsCompany.findUniqueOrThrow({ where: { slug_platform: { slug, platform } } })).lastProcessedAt, null);
    const retry = await prisma.atsBrowserDetailRetry.findUniqueOrThrow({ where: { slug_platform_postingId: { slug, platform, postingId: '1' } } });
    assert.equal(retry.status, 'pending'); assert.ok(retry.nextRetryAt > new Date());
    const run = await prisma.ingestionSourceRun.findFirstOrThrow({ where: { source: 'ATS-avature' }, orderBy: { createdAt: 'desc' } });
    assert.equal(run.reconciled, true);
    assert.equal(run.seenCount, run.insertedCount + run.duplicateCount + run.filteredCount + run.processingErrorCount);
    assert.equal(run.filteredCount, 2);
    assert.equal((run.checkpoint as { crawl: { complete: boolean; listingComplete: boolean; pendingDetails: number } }).crawl.complete, false);
    assert.equal((run.checkpoint as { crawl: { listingComplete: boolean } }).crawl.listingComplete, true);
    assert.equal(await prisma.atsPublicCapacityLease.count(), 0, 'worker releases its public reservation');
    const task = await prisma.ingestionTask.findFirstOrThrow({ where: { source: 'ATS-avature' } });
    assert.equal(task.leaseToken, null, 'worker releases its provider task');

    // Simulate the recorded retry becoming due, then prove the ordinary worker
    // selects recovery even though its completed listing is scheduled later.
    await prisma.atsBrowserDetailRetry.update({ where: { slug_platform_postingId: { slug, platform, postingId: '1' } }, data: { nextRetryAt: past } });
    closed = true; visited.length = 0;
    await runBrowserAtsWorker(options);
    assert.deepEqual(visited, [failed.url]);
    assert.equal((await prisma.atsBrowserDetailRetry.findUniqueOrThrow({ where: { slug_platform_postingId: { slug, platform, postingId: '1' } } })).status, 'closed');
    assert.equal((await prisma.atsBrowserSweep.findUniqueOrThrow({ where: { slug_platform: { slug, platform } } })).status, 'succeeded');
    assert.ok((await prisma.atsCompany.findUniqueOrThrow({ where: { slug_platform: { slug, platform } } })).lastProcessedAt);
    const recovery = await prisma.ingestionSourceRun.findFirstOrThrow({ where: { source: 'ATS-avature' }, orderBy: { createdAt: 'desc' } });
    assert.equal((recovery.checkpoint as { crawl: { firstCollectionCompleted: boolean } }).crawl.firstCollectionCompleted, true);
    assert.equal(await prisma.atsPublicCapacityLease.count(), 0);
}

async function main() {
    const url = new URL(process.env.DATABASE_URL || '');
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55447'); assert.equal(url.username, 'capacity_test');
    assert.match(url.pathname, /^\/career_capacity_fixtures_browser/);
    assert.equal(await prisma.atsCompany.count(), 0, 'fixture requires an empty database');
    const now = new Date(), past = new Date(+now - 86400000), future = new Date(+now + 86400000);
    await prisma.atsAcquisitionRuntimeGate.create({ data: { id: 'global', admissionState: 'open' } });
    await prisma.atsFirstCollectionPolicy.create({ data: { id: 'new-providers', mode: 'capacity', healthObservedAt: now } });
    const task = await prisma.ingestionTask.create({ data: { taskKey: 'browser-recovery-fixture', source: 'ATS-freshteam',
        ingestionMode: 'public-board', geoLane: 'source_posted_location', status: 'running',
        nextRunAt: past, leaseToken: 'browser-fixture-owner', leaseExpiresAt: future } });
    const owner = { taskId: task.id, leaseToken: task.leaseToken! };
    const slug = 'https://example.freshteam.com/jobs', platform = 'freshteam' as const;
    const boardKey = { slug_platform: { slug, platform } };
    await prisma.atsCompany.create({ data: { slug, platform, checkDay: 0, nextCheckDate: future, lastProcessedAt: past } });
    const job = await prisma.job.create({ data: { title: 'Preserved interviewed role', company: 'Example', description: 'Original evidence',
        postedAt: now, status: 'interviewing', scoringStatus: 'scored', fitScore: 81, aimFitScore: 91 } });
    const protectedBefore = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const links = ['1', '2', '3', '4', '5'].map(id => browserPostingLink(platform, slug, `/jobs/${id}/account-manager`, 'Account Manager')!);
    const original = loadBrowserSweepPage(newBrowserSweep(slug), { links: links.slice(0, 2), total: 3,
        signature: listingSignature(links.slice(0, 2)), next: { kind: 'click' } });
    original.offset = 2; original.seen = ['2']; original.detailFailures = [{ id: '1', message: 'Job detail lacks verified evidence' }];
    await prisma.atsBrowserSweep.create({ data: { slug, platform, status: 'partial', lastError: '1 detail remains', cursor: original as unknown as Prisma.InputJsonValue } });

    await assert.rejects(saveBrowserSweepProgress({ owner, platform, slug, progress: original, legacyRetryAt: future, now }), /existing retry date/);
    assert.equal(await prisma.atsBrowserDetailRetry.count(), 0);
    assert.equal((await readCrawlQueueHeads([platform], [slug], task.id)).length, 0, 'future legacy retry remains held');
    await prisma.atsCompany.update({ where: boardKey, data: { nextCheckDate: past } });
    const saved = await saveBrowserSweepProgress({ owner, platform, slug, progress: original, status: 'running', legacyRetryAt: past, now });
    const retryKey = { slug_platform_postingId: { slug, platform, postingId: '1' } };
    const initialRetry = await prisma.atsBrowserDetailRetry.findUniqueOrThrow({ where: retryKey });
    assert.equal(initialRetry.nextRetryAt.toISOString(), past.toISOString());
    assert.deepEqual(initialRetry.posting, links[0]);
    assert.deepEqual(saved.progress.seen, ['2']);
    assert.deepEqual(saved.progress.deferredDetailIds, ['1']);
    assert.equal(saved.progress.detailFailures, undefined);
    await saveBrowserSweepProgress({ owner, platform, slug, progress: original, legacyRetryAt: past, now: new Date(+now + 1000) });
    assert.deepEqual(await prisma.atsBrowserDetailRetry.findUniqueOrThrow({ where: retryKey }), initialRetry, 'replay preserves retry clocks, evidence and attempts');

    const malformed: BrowserSweepProgress = { ...original, queue: links.slice(3), seen: [],
        detailFailures: [{ id: '4', message: 'valid first retained row' }, { id: 'foreign', message: 'not in this page' }] };
    await assert.rejects(saveBrowserSweepProgress({ owner, platform, slug, progress: malformed, now }), /saved employer/);
    assert.equal(await prisma.atsBrowserDetailRetry.count(), 1, 'failed transfer rolls back every inserted retry');
    assert.equal((await prisma.atsBrowserSweep.findUniqueOrThrow({ where: boardKey })).cursor &&
        ((await prisma.atsBrowserSweep.findUniqueOrThrow({ where: boardKey })).cursor as unknown as BrowserSweepProgress).page, 1);
    await assert.rejects(saveBrowserSweepProgress({ owner: { ...owner, leaseToken: 'lost' }, platform, slug, progress: saved.progress, now }), /lost its task lease/);

    const next = advanceBrowserSweep(saved.progress)!;
    assert.equal(next.page, 2);
    const last = loadBrowserSweepPage(next, { links: [links[2]], total: 3, next: null, signature: listingSignature([links[2]]) });
    last.offset = 1; last.seen.push('3');
    assert.equal(advanceBrowserSweep(last), null);
    const done = await saveBrowserSweepProgress({ owner, platform, slug, progress: last, status: 'succeeded', refreshAt: future, now });
    assert.equal(done.status, 'listed');
    assert.equal(done.pendingDetails, 1);
    const afterListing = await prisma.atsCompany.findUniqueOrThrow({ where: boardKey });
    assert.equal(afterListing.jobsFound, 3);
    assert.equal(afterListing.lastSynchronizedAt?.toISOString(), now.toISOString());
    assert.equal(afterListing.lastProcessedAt?.toISOString(), past.toISOString(), 'pending details cannot claim full processing');
    let heads = await readCrawlQueueHeads([platform], [slug], task.id, prisma, 'browser');
    assert.equal(heads.length, 1); assert.equal(heads[0].queue, 'retry'); assert.equal(heads[0].workKind, 'detail');
    await prisma.providerCircuit.create({ data: { provider: 'ATS-freshteam', state: 'open', openUntil: future } });
    assert.equal((await readCrawlQueueHeads([platform], [slug], task.id, prisma, 'browser')).length, 0, 'provider pause fences independent recovery');
    await prisma.providerCircuit.update({ where: { provider: 'ATS-freshteam' }, data: { openUntil: past } });

    await settleBrowserDetailRetry({ owner, platform, slug, postingId: '1', attemptCount: 1,
        outcome: 'pending', error: 'Job details lack verified evidence', now });
    const held = await prisma.atsBrowserDetailRetry.findUniqueOrThrow({ where: retryKey });
    assert.equal(held.status, 'pending'); assert.equal(held.attemptCount, 2); assert.ok(held.nextRetryAt > now);
    await assert.rejects(settleBrowserDetailRetry({ owner, platform, slug, postingId: '1', attemptCount: 2, outcome: 'closed', now }), /changed before/);
    await prisma.atsCompany.update({ where: boardKey, data: { nextCheckDate: past } });
    heads = await readCrawlQueueHeads([platform], [slug], task.id, prisma, 'browser');
    assert.ok(heads.some(head => head.workKind === 'listing'), 'later refresh remains available while details wait');
    assert.ok(!heads.some(head => head.workKind === 'detail'), 'held detail never borrows the fresh-listing clock');
    const refreshed = newBrowserSweep(slug);
    refreshed.loaded = true; refreshed.total = 0; refreshed.signatures = [listingSignature([])];
    await saveBrowserSweepProgress({ owner, platform, slug, progress: refreshed, status: 'succeeded', refreshAt: future, now });
    assert.deepEqual(await prisma.atsBrowserDetailRetry.findUniqueOrThrow({ where: retryKey }), held, 'a new listing retains prior failed posting evidence');

    await prisma.atsCompany.update({ where: boardKey, data: { status: 'excluded', excludedReason: 'Fixture deliberate exclusion', excludedAt: now } });
    const dueLater = new Date(+held.nextRetryAt + 1);
    await assert.rejects(settleBrowserDetailRetry({ owner, platform, slug, postingId: '1', attemptCount: 2, outcome: 'closed', now: dueLater }), /retired/);
    assert.equal((await readCrawlQueueHeads([platform], [slug], task.id, prisma, 'browser')).length, 0);
    assert.deepEqual(await prisma.atsBrowserDetailRetry.findUniqueOrThrow({ where: retryKey }), held);
    await prisma.atsCompany.update({ where: boardKey, data: { status: 'active' } });
    await settleBrowserDetailRetry({ owner, platform, slug, postingId: '1', attemptCount: 2, outcome: 'closed', now: dueLater });
    const closed = await prisma.atsBrowserDetailRetry.findUniqueOrThrow({ where: retryKey });
    assert.equal(closed.status, 'closed'); assert.ok(closed.resolvedAt); assert.equal(closed.lastError, held.lastError);
    assert.deepEqual(closed.posting, initialRetry.posting);
    assert.equal((await prisma.atsBrowserSweep.findUniqueOrThrow({ where: boardKey })).status, 'succeeded');
    assert.equal((await prisma.atsCompany.findUniqueOrThrow({ where: boardKey })).lastProcessedAt?.toISOString(), dueLater.toISOString());
    await assert.rejects(settleBrowserDetailRetry({ owner, platform, slug, postingId: '1', attemptCount: 2, outcome: 'recovered', now: dueLater }), /changed before/);

    // A later independent ingestion resolves retained evidence without making
    // a premature network retry or waiting on its future retry timestamp.
    await prisma.atsBrowserDetailRetry.create({ data: { slug, platform, postingId: '2', posting: links[1],
        lastError: 'Old missing detail', nextRetryAt: future } });
    const alreadyObserved = await settleBrowserDetailRetry({ owner, platform, slug, postingId: '2', attemptCount: 1,
        outcome: 'already_observed', now });
    assert.equal(alreadyObserved.pendingDetails, 0);
    assert.equal((await prisma.atsBrowserDetailRetry.findUniqueOrThrow({ where: { slug_platform_postingId: { slug, platform, postingId: '2' } } })).status, 'already_observed');

    // Explicit diagnostic partitions: due, future and inactive evidence all stay visible.
    for (const [id, status, retryAt] of [['due', 'active', past], ['held', 'active', future], ['retired', 'excluded', past]] as const) {
        const other = `https://${id}.freshteam.com/jobs`;
        await prisma.atsCompany.create({ data: { slug: other, platform, checkDay: 0, status, nextCheckDate: future } });
        await prisma.atsBrowserDetailRetry.create({ data: { slug: other, platform, postingId: id, posting: links[0],
            lastError: 'Fixture retained detail', nextRetryAt: retryAt } });
    }
    const diagnostic = await readAtsQueueTelemetry();
    assert.deepEqual(diagnostic.browserDetails, { pending: 3, retryDateReached: 1, scheduled: 1, inactiveBoards: 1 });
    await completeWorkerRegression(past);
    assert.deepEqual(await prisma.job.findUniqueOrThrow({ where: { id: job.id } }), protectedBefore);
    console.log('Browser recovery PostgreSQL fixture passed: atomic transfer, old clocks, complete enumeration, independent retry, fencing, provider pause, exclusion, outcomes, diagnostics and score preservation.');
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
