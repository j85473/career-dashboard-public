import assert from 'node:assert/strict';
import test from 'node:test';
import { reserveAtsServiceTurn, finishAtsServiceTurn, readAtsServiceState,
  readServiceState, ATS_SERVICE_MAX_WAIT_MS } from '../atsServiceScheduling';
import { crawlServiceChoices, reserveCrawlBoardService } from '../crawlTimeBudget';
import type { CrawlProviderHead, CrawlQueue } from '../atsCrawlingSchedule';
import type { PrismaClient } from '../prismaClient';

// Simulate a new worker/client every turn, with only the database surviving.
// Real PostgreSQL concurrency and lease fencing have a separate integration test.
function database() {
  const rows = new Map<string, { resource: string; state: unknown }>();
  let tail = Promise.resolve();
  const store = {
    findUnique: async ({ where }: { where: { resource: string } }) => structuredClone(rows.get(where.resource) || null),
    upsert: async ({ where, create, update }: { where: { resource: string }; create: { state: unknown }; update: { state: unknown } }) => {
      const row = { resource: where.resource, state: structuredClone(rows.has(where.resource) ? update.state : create.state) };
      rows.set(where.resource, row); return row;
    },
    update: async ({ where, data }: { where: { resource: string }; data: { state: unknown } }) => {
      const row = { resource: where.resource, state: structuredClone(data.state) }; rows.set(where.resource, row); return row;
    },
  };
  const client = () => ({ atsSchedulerState: store, $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    const previous = tail; let unlock = () => {};
    tail = new Promise<void>(resolve => { unlock = resolve; }); await previous;
    try { return await run({ $executeRaw: async () => 0, atsSchedulerState: store }); } finally { unlock(); }
  } }) as unknown as PrismaClient;
  return { client };
}
const epoch = Date.parse('2026-11-16T12:00:00Z');

function crawlHead(queue: CrawlQueue, platform = 'icims'): CrawlProviderHead {
  return { queue, platform, slug: `${platform}-${queue}`, checkDay: 0, failCount: queue === 'retry' ? 1 : 0,
    lastSynchronizedAt: null, providerLastStartedAt: null };
}

test('returning browser queues reserve and select the same available board without losing a turn', async () => {
  const db = database();
  const first = (await reserveCrawlBoardService('browser', [crawlHead('first'), crawlHead('refresh')],
    { now: new Date(epoch), client: db.client() }))!;
  assert.equal(first.board.queue, 'first');
  await finishAtsServiceTurn(first.serviceTurn, true, new Date(epoch + 10000), db.client());
  // Refresh disappeared; retry returned. The old all-queue preview selected
  // retry, while reserving only these available queues selected first.
  const ready = [crawlHead('first'), crawlHead('retry')];
  const next = (await reserveCrawlBoardService('browser', ready,
    { now: new Date(epoch + 10001), client: db.client() }))!;
  assert.equal(next.serviceTurn.key, 'first');
  assert.equal(next.board.queue, next.serviceTurn.key);
  await finishAtsServiceTurn(next.serviceTurn, true, new Date(epoch + 20001), db.client());
  const retry = (await reserveCrawlBoardService('browser', ready,
    { now: new Date(epoch + 20002), client: db.client() }))!;
  assert.equal(retry.board.queue, 'retry', 'returning work still receives its share');
  assert.equal(retry.serviceTurn.key, retry.board.queue);
  await finishAtsServiceTurn(retry.serviceTurn, true, new Date(epoch + 21002), db.client());
  assert.equal(Object.keys((await readAtsServiceState('browser', db.client())).pending).length, 0);
});

test('concurrent queue reservations select matching boards and a lost claim refunds the turn', async () => {
  const db = database(), now = new Date(epoch);
  const heads = [crawlHead('first'), crawlHead('retry'), crawlHead('first', 'paylocity')];
  const selections = await Promise.all(Array.from({ length: 2 }, () =>
    reserveCrawlBoardService('http', heads, { now, client: db.client() })));
  assert.equal(new Set(selections.map(s => s!.serviceTurn.key)).size, 2);
  for (const s of selections) assert.equal(s!.board.queue, s!.serviceTurn.key);
  await finishAtsServiceTurn(selections[0]!.serviceTurn, false, now, db.client());
  const replacement = (await reserveCrawlBoardService('http', heads, { now, client: db.client() }))!;
  assert.equal(replacement.serviceTurn.key, selections[0]!.serviceTurn.key);
  assert.equal(replacement.board.queue, replacement.serviceTurn.key);
  assert.equal(await reserveCrawlBoardService('empty', [], { now, client: db.client() }), null);
});

test('short worker restarts preserve elapsed browser shares under mixed costs', async () => {
  const db = database(), choices = crawlServiceChoices(['first', 'refresh', 'continuation', 'retry']);
  const costs = { first: 15000, refresh: 1000, continuation: 3000, retry: 30000 };
  let now = epoch;
  for (let n = 0; n < 1800; n++) {
    const turn = (await reserveAtsServiceTurn('browser', choices, { now: new Date(now), client: db.client() }))!;
    now += costs[turn.key as keyof typeof costs];
    assert.equal(await finishAtsServiceTurn(turn, true, new Date(now), db.client()), true);
  }
  const state = await readAtsServiceState('browser', db.client());
  const total = Object.values(state.classes).reduce((sum, c) => sum + c.serviceMs, 0);
  for (const c of choices) assert.ok(Math.abs(state.classes[c.key].serviceMs / total - c.weight) < 0.025);
  assert.equal(Object.keys(state.pending).length, 0);
});

test('absent queues lend capacity and do not return with unlimited credit', async () => {
  const db = database(); let now = epoch;
  for (let n = 0; n < 30; n++) {
    const turn = (await reserveAtsServiceTurn('browser', crawlServiceChoices(['retry']), { now: new Date(now), client: db.client() }))!;
    now += 60000; await finishAtsServiceTurn(turn, true, new Date(now), db.client());
  }
  const selections: string[] = [];
  for (let n = 0; n < 200; n++) {
    const turn = (await reserveAtsServiceTurn('browser', crawlServiceChoices(['refresh', 'retry']), { now: new Date(now), client: db.client() }))!;
    selections.push(turn.key); now += 1000; await finishAtsServiceTurn(turn, true, new Date(now), db.client());
  }
  assert.ok(selections.filter(key => key === 'retry').length >= 45);
  assert.ok(selections.filter(key => key === 'retry').length <= 55);
});

test('continuous current work cannot starve overdue and recovery classes across four days', async () => {
  const db = database(); let now = epoch;
  const last = { current: epoch, overdue: epoch, recovery: epoch }, maxGap = { ...last };
  for (let n = 0; n < 4 * 24 * 60; n++) {
    const choices = Object.keys(last).map((key, priority) => ({ key, priority, readySince: epoch - 86400000 }));
    const turn = (await reserveAtsServiceTurn('api-listing', choices, { now: new Date(now), client: db.client() }))!;
    const key = turn.key as keyof typeof last;
    maxGap[key] = Math.max(maxGap[key] === epoch ? 0 : maxGap[key], now - last[key]); last[key] = now;
    now += 60000; await finishAtsServiceTurn(turn, true, new Date(now), db.client());
  }
  for (const key of ['overdue', 'recovery'] as const) assert.ok(maxGap[key] <= ATS_SERVICE_MAX_WAIT_MS + 120000);
});

test('lost claims refund provisional service and do not spend an opportunity', async () => {
  const db = database(), now = new Date(epoch);
  const turn = (await reserveAtsServiceTurn('api', [{ key: 'recovery', readySince: epoch - 86400000 }], { now, client: db.client() }))!;
  assert.equal(await finishAtsServiceTurn(turn, false, now, db.client()), true);
  assert.equal(await finishAtsServiceTurn(turn, true, now, db.client()), false);
  const state = await readAtsServiceState('api', db.client());
  assert.equal(state.classes.recovery.serviceMs, 0); assert.equal(state.classes.recovery.lastSelectedAt, 0);
  assert.equal(state.classes.recovery.virtualMs, 0);
});

test('abandoned work retains its bounded charge and stale finish cannot refund a new turn', async () => {
  const db = database();
  const old = (await reserveAtsServiceTurn('api', [{ key: 'recovery' }], { now: new Date(epoch), leaseMs: 1000, client: db.client() }))!;
  const fresh = (await reserveAtsServiceTurn('api', [{ key: 'recovery' }], { now: new Date(epoch + 1001), client: db.client() }))!;
  assert.equal(await finishAtsServiceTurn(old, false, new Date(epoch + 1002), db.client()), false);
  assert.ok((await readAtsServiceState('api', db.client())).pending[fresh.token]);
});

test('malformed accounting fails closed instead of creating new credit', () => {
  assert.throws(() => readServiceState({ classes: { retry: { serviceMs: Infinity } }, pending: {} }));
  assert.throws(() => readServiceState({ other: true }));
});
