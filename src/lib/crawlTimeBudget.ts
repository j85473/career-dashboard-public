import { selectFairCrawlBoard, type CrawlQueue, type CrawlProviderHead } from './atsCrawlingSchedule';
import { reserveAtsServiceTurn, finishAtsServiceTurn } from './atsServiceScheduling';
export const CRAWL_TIME_SHARES: Record<CrawlQueue, number> = { first: 0.4, refresh: 0.3, continuation: 0.2, retry: 0.1 };
/** Lowest spent/share wins. Missing queues lend their allocation to available work. */
export function crawlTimeOrder(spent: Record<CrawlQueue, number>): CrawlQueue[] {
    return (Object.keys(CRAWL_TIME_SHARES) as CrawlQueue[]).sort((a,b) => spent[a]/CRAWL_TIME_SHARES[a]-spent[b]/CRAWL_TIME_SHARES[b]);
}

export function crawlServiceChoices(queues: readonly CrawlQueue[]) {
    return (Object.keys(CRAWL_TIME_SHARES) as CrawlQueue[]).filter(key => queues.includes(key))
        .map((key, priority) => ({ key, priority, weight: CRAWL_TIME_SHARES[key] }));
}
/** Reserve once from the available heads, then select the board from that
 * exact queue. Returning/absent queues cannot change a separate preview's
 * service floor and make a healthy worker discard its turn. */
export async function reserveCrawlBoardService(resource: string, heads: readonly CrawlProviderHead[],
    options: Pick<NonNullable<Parameters<typeof reserveAtsServiceTurn>[2]>, 'now' | 'client'> = {}) {
    const serviceTurn = await reserveAtsServiceTurn(resource, crawlServiceChoices(heads.map(head => head.queue)),
        { ...options, quantumMs: 60_000, leaseMs: 300_000 });
    if (!serviceTurn) return null;
    try {
        const board = selectFairCrawlBoard(heads.filter(head => head.queue === serviceTurn.key), options.now);
        if (!board) throw Error('Reserved crawl queue has no eligible board');
        return { board, serviceTurn };
    } catch (error) {
        await finishAtsServiceTurn(serviceTurn, false, options.now, options.client);
        throw error;
    }
}
