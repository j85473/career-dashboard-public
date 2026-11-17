import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { publishAtsWebDiscoveries } from '../../src/lib/atsWebDiscoveryHandoff';
import { knownAtsBoardFromUrl } from '../../src/lib/atsWebDiscoveryLinks';
import { AtsWebDiscoveryState } from '../../src/lib/atsWebDiscoveryState';

type Client = Parameters<typeof publishAtsWebDiscoveries>[1];
const now = () => 1_000_000_000;
function discover(state: AtsWebDiscoveryState, url: string) {
  state.recordBoard(knownAtsBoardFromUrl(url)!, 'https://employer.example/careers', now());
}

test('handoff leaves existing active, parked, held, and excluded boards untouched', async () => {
  for (const status of ['active', 'parked', 'excluded']) {
    const state = new AtsWebDiscoveryState(':memory:');
    discover(state, 'https://jobs.lever.co/acme');
    try {
      const client = { atsCompany: { findMany: async () => [{ status, excludedReason: status === 'excluded' ? 'Operator retirement' : null }] } } as unknown as Client;
      const outcomes = await publishAtsWebDiscoveries(state, client, async () => { throw new Error('Existing board must not be validated'); }, 3, now);
      assert.deepEqual(outcomes, { [status === 'excluded' ? 'retired' : 'existing']: 1 });
      assert.equal(state.pendingCandidates(10, now()).length, 0);
    } finally { state.close(); }
  }
});

test('managed first collections skip existing admission inventory without revalidating it', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  discover(state, 'https://careers.jobscore.com/careers/acme/jobs/123');
  let inserts = 0;
  try {
    const client = {
      atsCompany: { findMany: async () => [] },
      atsFirstCollectionCandidate: { createMany: async (args: { skipDuplicates: boolean; data: unknown[] }) => {
        inserts++;
        assert.equal(args.skipDuplicates, true);
        assert.deepEqual(args.data, [{ platform: 'jobscore', slug: 'acme', sourceUrl: 'https://careers.jobscore.com/careers/acme/jobs/123' }]);
        return { count: 0 };
      } },
    } as unknown as Client;
    const outcomes = await publishAtsWebDiscoveries(state, client, async () => { throw new Error('Admission worker owns validation'); }, 3, now);
    assert.deepEqual(outcomes, { waiting_for_admission: 1 });
    assert.equal(inserts, 1);
  } finally { state.close(); }
});

test('temporary validation and database failures preserve discoveries for a later retry', async () => {
  for (const dbFailure of [false, true]) {
    const state = new AtsWebDiscoveryState(':memory:');
    discover(state, 'https://jobs.lever.co/acme');
    try {
      const client = { atsCompany: { findMany: async () => { if (dbFailure) throw new Error('Database unavailable'); return []; } } } as unknown as Client;
      const outcomes = await publishAtsWebDiscoveries(state, client, async () => ({ success: false, transient: true, reason: 'HTTP 429' }), 3, now);
      assert.deepEqual(outcomes, { retry: 1 });
      assert.equal(state.pendingCandidates(10, now()).length, 0);
      assert.equal(state.pendingCandidates(10, now() + 60 * 60_000)[0].slug, 'acme');
    } finally { state.close(); }
  }
});

test('a failed board validation never creates a schedulable board', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  discover(state, 'https://jobs.lever.co/acme');
  try {
    const client = { atsCompany: { findMany: async () => [] } } as unknown as Client;
    const outcomes = await publishAtsWebDiscoveries(state, client, async () => ({ success: false, reason: 'HTTP 404' }), 3, now);
    assert.deepEqual(outcomes, { rejected: 1 });
  } finally { state.close(); }
});

test('a supported browser board enters the existing weekly first-crawl path', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const boardUrl = 'https://jobs.jobvite.com/acme/jobs';
  discover(state, boardUrl);
  let created: Record<string, unknown> | undefined;
  try {
    const tx = {
      $executeRaw: async () => 1,
      atsCompany: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => { created = data; },
      },
      atsRotationBalanceState: { findUnique: async () => null },
    };
    const client = { atsCompany: tx.atsCompany, $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) } as unknown as Client;
    const outcomes = await publishAtsWebDiscoveries(state, client, async () => ({ success: false, browserPending: true }), 3, now);
    assert.deepEqual(outcomes, { registered: 1 });
    assert.equal(created?.platform, 'jobvite');
    assert.equal(created?.slug, boardUrl);
    assert.equal(created?.status, 'parked');
    assert.equal(created?.jobsFound, 0);
    assert.ok(created?.nextCheckDate instanceof Date);
  } finally { state.close(); }
});

test('candidate evidence keeps its original source when encountered again', () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const board = knownAtsBoardFromUrl('https://jobs.lever.co/acme')!;
  try {
    state.recordBoard(board, 'https://first.example/careers', now());
    state.recordBoard(board, 'https://second.example/careers', now() + 1);
    assert.equal(state.pendingCandidates(10, now())[0].sourceUrl, 'https://first.example/careers');
  } finally { state.close(); }
});

test('an empty feed is rechecked after its weekly hold even without rediscovery', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  discover(state, 'https://jobs.lever.co/acme');
  const client = { atsCompany: { findMany: async () => [] } } as unknown as Client;
  try {
    assert.deepEqual(await publishAtsWebDiscoveries(state, client,
      async () => ({ success: false, reason: 'No jobs listed' }), 3, now), { retry: 1 });
    assert.equal(state.pendingCandidates(3, now() + 7 * 86_400_000 - 1).length, 0);
    let calls = 0;
    const outcomes = await publishAtsWebDiscoveries(state, client, async () => {
      calls++;
      return { success: false, transient: true, reason: 'HTTP 429' };
    }, 3, () => now() + 7 * 86_400_000);
    assert.equal(calls, 1);
    assert.deepEqual(outcomes, { retry: 1 });
  } finally { state.close(); }
});

test('only historical empty-feed rejections regain a validation opportunity', async () => {
  const state = new AtsWebDiscoveryState(':memory:');
  const empty = knownAtsBoardFromUrl('https://jobs.lever.co/empty')!;
  const absent = knownAtsBoardFromUrl('https://jobs.lever.co/absent')!;
  const retired = knownAtsBoardFromUrl('https://jobs.lever.co/retired')!;
  try {
    for (const board of [empty, absent, retired]) state.recordBoard(board, 'https://employer.example/careers', now());
    state.finishCandidate(empty, 'rejected', now(), 'No jobs listed');
    state.finishCandidate(absent, 'rejected', now(), 'HTTP 404');
    state.finishCandidate(retired, 'retired', now(), 'No jobs listed');
    assert.equal(state.pendingCandidates(10, now() + 7 * 86_400_000).length, 0);
    assert.deepEqual(state.pendingCandidates(10, now() + 8 * 86_400_000).map(board => board.slug), ['empty']);
    // A permanent retirement discovered since the original rejection wins.
    const client = { atsCompany: { findMany: async () => [{ status: 'excluded', excludedReason: 'Operator retirement' }] } } as unknown as Client;
    assert.deepEqual(await publishAtsWebDiscoveries(state, client,
      async () => { throw Error('Retired board must not be fetched'); }, 3, () => now() + 8 * 86_400_000), { retired: 1 });
    assert.equal(state.pendingCandidates(10, now() + 100 * 86_400_000).length, 0);
  } finally { state.close(); }
});

test('the six legacy empty-feed rejections retain original evidence and append recovery receipts', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'discovery-empty-history-'));
  const file = path.join(directory, 'state.sqlite');
  new AtsWebDiscoveryState(file).close();
  let db = new DatabaseSync(file);
  const insert = db.prepare(`INSERT INTO boards(platform,slug,matched_url,source_url,first_seen,last_seen,status,attempts,next_at,last_error)
    VALUES('lever',?,?,'https://original.example/careers',1,2,'rejected',1,?,'No jobs listed')`);
  for (let n = 0; n < 6; n++) insert.run(`empty-${n}`, `https://jobs.lever.co/empty-${n}`, now() - 8 * 86_400_000);
  db.close();
  const state = new AtsWebDiscoveryState(file);
  try {
    const client = { atsCompany: { findMany: async () => [] } } as unknown as Client;
    assert.deepEqual(await publishAtsWebDiscoveries(state, client,
      async () => ({ success: false, reason: 'No jobs listed' }), 10, now), { retry: 6 });
    assert.equal(state.pendingCandidates(10, now()).length, 0);
  } finally { state.close(); }
  db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM board_handoff_history WHERE attempt=1 AND status='rejected' AND last_error='No jobs listed'").get()!.n, 6);
    assert.equal(db.prepare("SELECT count(*) n FROM boards WHERE attempts=2 AND status='retry' AND first_seen=1 AND last_seen=2 AND source_url='https://original.example/careers'").get()!.n, 6);
    assert.equal(db.prepare("SELECT count(*) n FROM board_handoff_history WHERE attempt=2 AND status='retry'").get()!.n, 6);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
