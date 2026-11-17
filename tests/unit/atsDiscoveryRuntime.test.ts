import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoveryRuntimeAlive, readDiscoveryRuntime, requestDiscoveryStart, requestDiscoveryStop, startDiscoveryRuntime } from '../../src/lib/atsDiscoveryRuntime';
import { createDiscoveryRecoveryCadence, discoveryRecoveryOutcome, validDiscoveryRecoveryIdentity } from '../../src/lib/atsDiscoveryValidationRecovery';

test('manual request is consumed once, survives web restart, and stops only its current worker', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'discovery-control-'));
  let runtime: Awaited<ReturnType<typeof startDiscoveryRuntime>> | undefined;
  try {
    const request = await requestDiscoveryStart(directory);
    assert.equal((await readDiscoveryRuntime(directory)).starting, true);
    await assert.rejects(requestDiscoveryStart(directory), /already running or starting/);
    runtime = await startDiscoveryRuntime('scan', true, directory);
    assert.equal((await readDiscoveryRuntime(directory)).token, request.token);
    await assert.rejects(startDiscoveryRuntime('scan', true, directory), /already consumed/);
    await assert.rejects(requestDiscoveryStop('old-owner', directory), /owner changed/);
    assert.equal(await requestDiscoveryStop(request.token, directory), 'stopping');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(runtime.signal.aborted, true);
    assert.equal((await readDiscoveryRuntime(directory)).isRunning, true, 'stop acknowledgement retains running until in-flight work finishes');
    await runtime.finish(); runtime = undefined;
    assert.equal((await readDiscoveryRuntime(directory)).status?.state, 'stopped');
    const recovery = await startDiscoveryRuntime('recovery', false, directory);
    const state = await readDiscoveryRuntime(directory);
    await assert.rejects(requestDiscoveryStop(state.token!, directory), /finish independently/);
    await recovery.finish();
    assert.equal((await readDiscoveryRuntime(directory)).startupExpired, false, 'old consumed request cannot become a later phantom startup failure');
  } finally { await runtime?.finish(); await rm(directory, { recursive: true, force: true }); }
});

test('cancelled pending start and expired bridge request do not claim success', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'discovery-control-'));
  try {
    const request = await requestDiscoveryStart(directory);
    assert.equal(await requestDiscoveryStop(request.token, directory), 'stopped');
    assert.equal((await readDiscoveryRuntime(directory)).requestCancelled, true);
    const runtime = await startDiscoveryRuntime('scan', true, directory);
    assert.equal(runtime.signal.aborted, true);
    await runtime.finish();
    await writeFile(path.join(directory, 'discovery-manual-request.json'), JSON.stringify({ token: 'expired', requestedAt: new Date(0).toISOString() }));
    assert.equal((await readDiscoveryRuntime(directory)).startupExpired, true);
    await assert.rejects(startDiscoveryRuntime('scan', true, directory), /expired/);
    const status = JSON.parse(await readFile(path.join(directory, 'discovery-status.json'), 'utf8'));
    assert.equal(discoveryRuntimeAlive({ ...status, state: 'running', heartbeatAt: new Date().toISOString() }, Date.now(), () => false), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('validation recovery keeps provider holds and sends malformed/exhausted candidates to visible review', () => {
  const now = new Date('2026-11-16T00:00:00Z');
  const retryAt = new Date('2027-01-01T00:00:00Z');
  assert.equal(discoveryRecoveryOutcome({ success: false, deferred: true, retryAt }, 8, now).state, 'retry');
  assert.equal(discoveryRecoveryOutcome({ success: false, deferred: true, retryAt }, 8, now).nextAttemptAt.getTime(), retryAt.getTime());
  assert.equal(discoveryRecoveryOutcome({ success: false, reason: 'HTTP 503' }, 8, now).state, 'review');
  assert.equal(validDiscoveryRecoveryIdentity('workday', 'frijol-usa.comrelx.wd3::robots.txt'), false);
  assert.equal(validDiscoveryRecoveryIdentity('workday', 'adobe.wd5::external_experienced'), true);
});

test('recovery checkpoints share one bounded pass and stop never opens a new entitlement', async () => {
  let now = 0, calls = 0;
  let finish!: () => void;
  const controller = new AbortController();
  const service = createDiscoveryRecoveryCadence(async () => {
    calls++;
    await new Promise<void>(resolve => { finish = resolve; });
    return calls;
  }, { now: () => now, signal: controller.signal });
  const first = service(), peer = service();
  assert.equal(first, peer);
  await Promise.resolve();
  now = 10 * 60_000;
  assert.equal(service(), first, 'even a long pass cannot overlap a new one');
  finish(); await first;
  const second = service();
  await Promise.resolve(); finish(); await second;
  assert.equal(calls, 2, 'missed intervals do not accumulate catch-up passes');
  assert.equal(await service(), undefined);
  now += 5 * 60_000;
  controller.abort();
  assert.equal(await service(), undefined);
  assert.equal(calls, 2);
});
