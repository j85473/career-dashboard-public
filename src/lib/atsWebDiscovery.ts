import {
  discoveryLinkPriority, extractAtsDiscoveryLinks, extractSequoiaDiscoveryLinks, isExplorableDiscoveryUrl, knownAtsBoardFromUrl, normalizeDiscoveryUrl,
} from './atsWebDiscoveryLinks';
import { DISCOVERY_USER_AGENT, discoveryRobotsAllows, parseDiscoveryRobots } from './atsWebDiscoveryRobots';
import { AtsWebDiscoveryState, type DiscoveryPage } from './atsWebDiscoveryState';
import { safeExternalFetch } from './safeExternalFetch';
import { isSequoiaDiscoveryApiUrl, SEQUOIA_DISCOVERY_BOOTSTRAP, sequoiaDiscoveryRequest,
  sequoiaDiscoverySession, type SequoiaDiscoverySession } from './sequoiaDiscovery';

export const ATS_WEB_DISCOVERY_DEFAULTS = {
  maxRequests: 60, maxSeconds: 300, maxResponseBytes: 2 * 1024 * 1024, maxBytes: 32 * 1024 * 1024,
  globalIntervalMs: 1000, hostIntervalMs: 5000, requestsPerHostPerDay: 20,
  maxDepth: 5, maxUrls: 500_000, revisitMs: 7 * 86_400_000,
};
export type WebDiscoveryOptions = typeof ATS_WEB_DISCOVERY_DEFAULTS;
type Request = (url: string, init: RequestInit, maximumBytes: number) => Promise<Response>;
export type WebDiscoveryDependencies = {
  request?: Request; now?: () => number; sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal; pressure?: () => string | null;
};
const REDIRECT = new Set([301, 302, 303, 307, 308]);
class Deferred extends Error {}
class BudgetReached extends Error {}

function retryAfter(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  const until = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(until) ? Math.max(now, until) : 0;
}

/** One bounded pass. Successful page evidence and newly discovered work commit together. */
export async function runAtsWebDiscovery(
  state: AtsWebDiscoveryState, seeds: readonly string[], overrides: Partial<WebDiscoveryOptions> = {},
  dependencies: WebDiscoveryDependencies = {},
) {
  const options = { ...ATS_WEB_DISCOVERY_DEFAULTS, ...overrides };
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : 1)) throw new Error(`Invalid discovery option: ${key}`);
  }
  if (options.maxResponseBytes > 2 * 1024 * 1024) throw new Error('Discovery page limit cannot exceed 2 MiB');
  if (options.maxBytes < options.maxResponseBytes) throw new Error('Discovery byte budget must fit at least one response');
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const request = dependencies.request || ((url, init, maximumBytes) => safeExternalFetch(url, init, 0, { maximumBytes, maximumAddressAttempts: 1 }));
  const started = now();
  const deadline = started + options.maxSeconds * 1000;
  let requests = 0;
  let bytes = 0;
  let pages = 0;
  let stopReason = 'idle';
  let sequoiaSession: SequoiaDiscoverySession | undefined;

  const checkBudget = () => {
    if (dependencies.signal?.aborted) throw new BudgetReached('interrupted');
    if (now() >= deadline) throw new BudgetReached('time_budget');
    const pressure = dependencies.pressure?.();
    if (pressure) throw new BudgetReached(pressure);
    state.renew(now());
  };
  const wait = async (until: number) => {
    const ms = until - now();
    if (ms <= 0) return;
    if (ms > 20_000) throw new Deferred('Waiting for a host request interval or cooldown');
    if (now() + ms >= deadline) throw new BudgetReached('time_budget');
    await sleep(ms);
    checkBudget();
  };

  const fetchOne = async (url: string, maximumBytes: number, robots = false,
    override?: ReturnType<typeof sequoiaDiscoveryRequest>): Promise<{ response: Response; body: string }> => {
    checkBudget();
    if (requests >= options.maxRequests) throw new BudgetReached('request_budget');
    if (bytes + maximumBytes > options.maxBytes) throw new BudgetReached('byte_budget');
    const origin = new URL(url).origin;
    let host = state.host(origin);
    if (host.window_at > now() - 86_400_000 && host.requests >= options.requestsPerHostPerDay) {
      throw new Deferred('Host daily request allowance reached');
    }
    await wait(Math.max(host.next_at, host.cooldown_until, state.metric('nextGlobalRequestAt')));
    host = state.host(origin);
    state.reserveRequest(origin, now(), Math.max(options.hostIntervalMs, host.robots_delay), options.globalIntervalMs);
    requests++;
    try {
      const remaining = Math.max(1, Math.min(15_000, deadline - now()));
      const timeout = AbortSignal.timeout(remaining);
      const response = await request(url, {
        method: override?.method || 'GET', ...(override ? { body: override.body } : {}), redirect: 'manual',
        signal: dependencies.signal ? AbortSignal.any([timeout, dependencies.signal]) : timeout,
        headers: { 'User-Agent': DISCOVERY_USER_AGENT, Accept: robots ? 'text/plain' : 'text/html,application/xhtml+xml', ...override?.headers },
      }, maximumBytes);
      const payload = new Uint8Array(await response.arrayBuffer());
      if (payload.byteLength > maximumBytes) throw new Error('Discovery response exceeded its byte allowance');
      bytes += payload.byteLength;
      state.increment('bytesRead', payload.byteLength);
      if (response.status === 429 || response.status >= 500) {
        const until = Math.max(now() + 15 * 60_000, retryAfter(response.headers.get('retry-after'), now()));
        state.cooldown(origin, until);
      }
      return { response, body: new TextDecoder().decode(payload) };
    } catch (error) {
      // A failed/oversized transfer still consumes its maximum allowance. This
      // bounds repeated failures even when transport cannot report partial bytes.
      bytes += maximumBytes;
      throw error;
    }
  };

  const robotsAllowed = async (page: DiscoveryPage): Promise<boolean> => {
    let host = state.host(page.origin);
    if (host.robots_until <= now()) {
      let url = `${page.origin}/robots.txt`;
      let body = '';
      let kind = 'retry';
      let delay = 0;
      for (let hop = 0; hop <= 5; hop++) {
        const result = await fetchOne(url, 512 * 1024, true);
        if (REDIRECT.has(result.response.status)) {
          const location = result.response.headers.get('location');
          const target = location ? normalizeDiscoveryUrl(location, url) : null;
          if (!target || hop === 5) break;
          url = target;
          continue;
        }
        if (result.response.ok && !/^\s*</.test(result.body)) {
          body = result.body;
          kind = 'allow';
          delay = parseDiscoveryRobots(body).crawlDelayMs;
        } else if ([404, 410].includes(result.response.status)) {
          kind = 'allow';
        } else if ([401, 403].includes(result.response.status)) {
          kind = 'deny';
        }
        break;
      }
      state.saveRobots(page.origin, body, kind, now() + (kind === 'retry' ? 60 * 60_000 : 86_400_000), delay);
      host = state.host(page.origin);
      // The just-learned crawl-delay also applies between robots.txt and the page.
      if (delay > options.hostIntervalMs) state.cooldown(page.origin, now() + delay);
    }
    if (host.robots_kind === 'retry') throw new Deferred('Robots rules temporarily unavailable');
    return host.robots_kind === 'allow' && discoveryRobotsAllows(parseDiscoveryRobots(host.robots_body), page.url);
  };

  state.acquire(now());
  try {
    state.transaction(() => {
      for (const seed of seeds) {
        const url = normalizeDiscoveryUrl(seed);
        if (!url) throw new Error('Seed is not a valid public HTTP(S) URL');
        const board = knownAtsBoardFromUrl(url);
        if (board) state.recordBoard(board, url, now());
        else if (isExplorableDiscoveryUrl(url)) state.enqueue(url, url, 0, discoveryLinkPriority(url), now(), options.maxUrls);
      }
    });
    while (true) {
      checkBudget();
      if (requests >= options.maxRequests) throw new BudgetReached('request_budget');
      const page = state.nextPage(now(), options.requestsPerHostPerDay, state.metric('pagesVisited') % 5 === 4);
      if (!page) {
        const due = state.nextDue(options.requestsPerHostPerDay, now());
        if (due !== null && due <= now() + 20_000) { await wait(Math.max(now() + 10, due)); continue; }
        stopReason = due === null ? 'idle' : 'waiting_for_due_work';
        break;
      }
      try {
        if (!await robotsAllowed(page)) {
          state.finishPage(page.url, 'blocked', now() + 86_400_000, null, 'Site robots rules disallow this page');
          continue;
        }
        const sequoiaApi = isSequoiaDiscoveryApiUrl(page.url);
        if (sequoiaApi && !sequoiaSession) {
          if (!await robotsAllowed({ ...page, url: SEQUOIA_DISCOVERY_BOOTSTRAP })) {
            throw new Deferred('Sequoia directory bootstrap disallowed by robots');
          }
          const bootstrap = await fetchOne(SEQUOIA_DISCOVERY_BOOTSTRAP, options.maxResponseBytes);
          if (!bootstrap.response.ok || !/text\/html/i.test(bootstrap.response.headers.get('content-type') || '')) {
            throw new Deferred('Sequoia public directory temporarily unavailable');
          }
          sequoiaSession = sequoiaDiscoverySession(bootstrap.body, bootstrap.response.headers.getSetCookie());
        }
        const { response, body } = await fetchOne(page.url, options.maxResponseBytes, false,
          sequoiaApi ? sequoiaDiscoveryRequest(page.url, sequoiaSession!) : undefined);
        if (page.url === SEQUOIA_DISCOVERY_BOOTSTRAP && response.ok) {
          try { sequoiaSession = sequoiaDiscoverySession(body, response.headers.getSetCookie()); }
          catch { /* A direct API visit can obtain a fresh anonymous session later. */ }
        }
        if (REDIRECT.has(response.status)) {
          const location = response.headers.get('location');
          const target = location ? normalizeDiscoveryUrl(location, page.url) : null;
          state.transaction(() => {
            state.finishPage(page.url, 'visited', now() + options.revisitMs, response.status);
            const board = target ? knownAtsBoardFromUrl(target) : null;
            if (board) state.recordBoard(board, page.url, now());
            else if (target && target !== page.url && page.redirect_hops < 5 && isExplorableDiscoveryUrl(target)) {
              state.enqueue(target, page.url, page.depth, page.priority, now(), options.maxUrls, page.redirect_hops + 1);
            }
          });
        } else if (response.ok && (sequoiaApi || /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get('content-type') || ''))) {
          const nofollow = /(?:^|[\s,:])(?:nofollow|none)(?:$|[\s,])/i.test(response.headers.get('x-robots-tag') || '');
          if (sequoiaApi && !/application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('Sequoia returned no directory JSON');
          const found = nofollow ? { boards: [], links: [] } : sequoiaApi
            ? extractSequoiaDiscoveryLinks(body, page.url) : extractAtsDiscoveryLinks(body, page.url);
          state.transaction(() => {
            // Release this page's queue slot before admitting its children.
            // A failed commit restores the page, its slot and its discoveries.
            state.finishPage(page.url, 'visited', now() + options.revisitMs, response.status);
            for (const board of found.boards) state.recordBoard(board, page.url, now());
            for (const link of found.links) {
              const depth = page.depth + (link.depthDelta ?? 1);
              if (depth <= options.maxDepth) state.enqueue(link.url, page.url, depth, link.priority, now(), options.maxUrls);
            }
            state.increment('pagesVisited');
          });
          pages++;
        } else if (response.status === 429 || response.status === 408 || response.status >= 500
          || sequoiaApi && [401, 403, 412].includes(response.status)) {
          if (sequoiaApi) sequoiaSession = undefined;
          state.finishPage(page.url, 'retry', Math.max(now() + 15 * 60_000, state.host(page.origin).cooldown_until), response.status, `HTTP ${response.status}`);
        } else {
          state.finishPage(page.url, 'ignored', now() + 30 * 86_400_000, response.status, 'Not an accessible HTML discovery page');
        }
      } catch (error) {
        if (error instanceof BudgetReached) throw error;
        if (error instanceof Deferred) {
          const host = state.host(page.origin);
          state.finishPage(page.url, 'retry', Math.max(now() + 60_000, host.cooldown_until,
            host.robots_kind === 'retry' ? host.robots_until : 0), null, error.message);
        } else {
          const delay = Math.min(86_400_000, 60_000 * 2 ** Math.min(page.attempts, 10));
          state.finishPage(page.url, 'retry', now() + delay, null, 'Discovery fetch or extraction failed; page retained for retry');
        }
      }
    }
  } catch (error) {
    if (error instanceof BudgetReached || error instanceof Deferred) stopReason = error.message;
    else throw error;
  } finally {
    state.release();
  }
  return { stopReason, requests, bytesBudgetUsed: bytes, pagesVisited: pages, elapsedMs: now() - started, inventory: state.report(options.maxUrls) };
}
