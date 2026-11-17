import { prisma } from './prisma';
import { Prisma, type PrismaClient } from './prismaClient';
import { browserPostingLink, type BrowserPostingLink } from './browserAtsPosting';
import type { BrowserAtsPlatform } from './browserAtsBoards';
import { BrowserSweepDeferred, browserListingCompleted } from './browserAtsTransport';
import { browserCrawlRetry } from './browserAtsRetry';
import { browserSweepEnumeratedCount, detachBrowserSweepDetails, type BrowserSweepProgress } from './browserAtsProgress';

type Owner = { taskId: string; leaseToken: string };
const asJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export const BROWSER_DETAIL_RECOVERY_TURN_LIMIT = 5;

async function fence(tx: Prisma.TransactionClient, owner: Owner, platform: string, slug: string, now: Date) {
    const owned = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "IngestionTask"
      WHERE id=${owner.taskId} AND "leaseToken"=${owner.leaseToken} AND status='running' AND "leaseExpiresAt">${now}
      FOR UPDATE`;
    if (!owned.length) throw new BrowserSweepDeferred('Public-board worker lost its task lease');
    const boards = await tx.$queryRaw<Array<{ slug: string }>>`SELECT slug FROM "AtsCompany"
      WHERE slug=${slug} AND platform=${platform} AND status IN ('active','parked') FOR UPDATE`;
    if (!boards.length) throw new BrowserSweepDeferred('Board was retired; saved evidence remains unchanged');
}

/** Persist exact failed links and their cursor handoff together. Existing retry
 * dates and attempts survive replay. Legacy failures move only on a normal due
 * turn, retaining the board's original retry timestamp. */
export async function saveBrowserSweepProgress(input: {
    owner: Owner; platform: BrowserAtsPlatform; slug: string; progress: BrowserSweepProgress;
    status?: string; error?: string | null; yieldAt?: Date | null; legacyRetryAt?: Date; refreshAt?: Date;
    now?: Date; client?: PrismaClient;
}): Promise<{ progress: BrowserSweepProgress; status: string; pendingDetails: number }> {
    const now = input.now || new Date(), client = input.client || prisma;
    if (input.progress.detailFailures?.length && input.legacyRetryAt && input.legacyRetryAt > now)
        throw new BrowserSweepDeferred('Retained detail transfer is waiting for its existing retry date');
    return client.$transaction(async tx => {
        await fence(tx, input.owner, input.platform, input.slug, now);
        for (const failure of input.progress.detailFailures || []) {
            const posting = input.progress.queue.find(link => link.id === failure.id);
            if (!posting || browserPostingLink(input.platform, input.slug, posting.url)?.id !== failure.id)
                throw Error('Failed posting is not bound to its saved employer');
            await tx.atsBrowserDetailRetry.createMany({ data: [{ slug: input.slug, platform: input.platform,
                postingId: failure.id, posting: asJson(posting), lastError: failure.message,
                nextRetryAt: input.legacyRetryAt || browserCrawlRetry(failure.message, 0, now).nextRetryAt,
                lastAttemptedAt: input.legacyRetryAt ? null : now, firstFailedAt: now }], skipDuplicates: true });
            // A previously closed posting may be published again. Preserve its
            // original failure/resolution dates while retaining the new failure.
            await tx.atsBrowserDetailRetry.updateMany({ where: { slug: input.slug, platform: input.platform,
                postingId: failure.id, status: { not: 'pending' } }, data: { status: 'pending', posting: asJson(posting),
                lastError: failure.message, attemptCount: { increment: 1 }, lastAttemptedAt: now,
                nextRetryAt: input.legacyRetryAt || browserCrawlRetry(failure.message, 0, now).nextRetryAt } });
        }
        const progress = detachBrowserSweepDetails(input.progress);
        const pendingDetails = await tx.atsBrowserDetailRetry.count({ where: { slug: input.slug, platform: input.platform, status: 'pending' } });
        const status = input.status === 'succeeded' && pendingDetails ? 'listed' : input.status || 'partial';
        const data = { cursor: asJson(progress), status, lastError: input.error ?? null,
            ...(browserListingCompleted(status) ? { lastCompletedAt: now } : {}) };
        await tx.atsBrowserSweep.upsert({ where: { slug_platform: { slug: input.slug, platform: input.platform } },
            create: { slug: input.slug, platform: input.platform, ...data }, update: data });
        if (input.status === 'succeeded' && input.refreshAt) {
            await tx.atsCompany.update({ where: { slug_platform: { slug: input.slug, platform: input.platform } }, data: {
                status: 'active', jobsFound: browserSweepEnumeratedCount(progress), failCount: 0,
                lastCheckedAt: now, lastSynchronizedAt: now, nextCheckDate: input.refreshAt,
                ...(!pendingDetails ? { lastProcessedAt: now } : {}),
            } });
        }
        if (input.yieldAt) await tx.atsCompany.update({ where: { slug_platform: { slug: input.slug, platform: input.platform } }, data: { nextCheckDate: input.yieldAt } });
        return { progress, status, pendingDetails };
    }, { timeout: 10000 });
}

export function readBrowserRetryPosting(platform: BrowserAtsPlatform, board: string, id: string, value: unknown): BrowserPostingLink {
    const posting = value as BrowserPostingLink;
    if (!posting || posting.id !== id || typeof posting.url !== 'string' || typeof posting.title !== 'string'
        || browserPostingLink(platform, board, posting.url)?.id !== id)
        throw Error('Retained posting identity is invalid; preserving it for review');
    return posting;
}

/** No row is removed: closure, recovery and deduplication remain inspectable.
 * The exact attempt number fences stale results as well as the provider lease. */
export async function settleBrowserDetailRetry(input: {
    owner: Owner; platform: BrowserAtsPlatform; slug: string; postingId: string; attemptCount: number;
    outcome: 'recovered' | 'closed' | 'already_observed' | 'pending'; error?: string; now?: Date; client?: PrismaClient;
}): Promise<{ pendingDetails: number; boardCompleted: boolean; firstCollectionCompleted: boolean }> {
    const now = input.now || new Date(), client = input.client || prisma;
    return client.$transaction(async tx => {
        await fence(tx, input.owner, input.platform, input.slug, now);
        const changed = await tx.atsBrowserDetailRetry.updateMany({ where: { slug: input.slug, platform: input.platform,
            postingId: input.postingId, status: 'pending', attemptCount: input.attemptCount,
            ...(input.outcome === 'already_observed' ? {} : { nextRetryAt: { lte: now } }) },
            data: { status: input.outcome, attemptCount: { increment: 1 }, lastAttemptedAt: now,
                ...(input.outcome === 'pending' ? { lastError: (input.error || 'Posting evidence remains unavailable').slice(0, 500),
                    nextRetryAt: browserCrawlRetry(input.error || 'Job details lack verified evidence', input.attemptCount, now).nextRetryAt }
                    : { resolvedAt: now }) } });
        if (!changed.count) throw new BrowserSweepDeferred('Retained posting changed before its result could be saved');
        const pending = await tx.atsBrowserDetailRetry.count({ where: { slug: input.slug, platform: input.platform, status: 'pending' } });
        let boardCompleted = false, firstCollectionCompleted = false;
        if (!pending) {
            const completed = await tx.atsBrowserSweep.updateMany({ where: { slug: input.slug, platform: input.platform, status: 'listed' }, data: { status: 'succeeded' } });
            if (completed.count) {
                boardCompleted = true;
                const board = await tx.atsCompany.findUniqueOrThrow({ where: { slug_platform: { slug: input.slug, platform: input.platform } }, select: { lastProcessedAt: true } });
                firstCollectionCompleted = board.lastProcessedAt === null;
                await tx.atsCompany.update({ where: { slug_platform: { slug: input.slug, platform: input.platform } }, data: { lastProcessedAt: now } });
            }
        }
        return { pendingDetails: pending, boardCompleted, firstCollectionCompleted };
    }, { timeout: 10000 });
}
