import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { acquisitionCanContinueDuringHandoff, initializeWorkerDrainLanes, setWorkerLaneDrained,
  workerDeploymentBlocked, workerDrainRequested, workerLanesDrained } from '../../src/lib/workerDeployment';
import { supervisePipelineLoop } from '../../src/lib/pipelineLoopSupervisor';
import { pipelineOperatorStopRequested, type PipelineStateClient } from '../../src/lib/pipelineState';
import { createPipelineControlServer } from '../../src/lib/pipelineControlServer';
import { requestPipelineService } from '../../src/lib/pipelineServiceClient';

async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Fixture did not reach its checkpoint.'); await delay(5); }
}
function context(component: string) {
  const directory = fs.mkdtempSync('/tmp/cd-worker-drain-');
  const prior = { component: process.env.CAREER_WORKER_COMPONENT, directory: process.env.WORKER_DRAIN_DIRECTORY };
  process.env.CAREER_WORKER_COMPONENT = component; process.env.WORKER_DRAIN_DIRECTORY = directory;
  const token = randomUUID();
  const mark = (name = component, softDrain = true, resumeMode: 'full' | null = null, deadline = Date.now() + 60_000) => {
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({ version: 1, component: name, token, softDrain, resumeMode, deadline }));
  };
  return { directory, mark, token, cleanup: () => {
    if (prior.component === undefined) delete process.env.CAREER_WORKER_COMPONENT; else process.env.CAREER_WORKER_COMPONENT = prior.component;
    if (prior.directory === undefined) delete process.env.WORKER_DRAIN_DIRECTORY; else process.env.WORKER_DRAIN_DIRECTORY = prior.directory;
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

test('soft drain finishes each current task, holds new claims, and resumes the same lanes when canceled', async () => {
  const c = context('pipeline'); const controller = new AbortController();
  const calls = [0, 0]; const release: Array<() => void> = [];
  const barriers = [0, 1].map((index) => new Promise<void>((resolve) => { release[index] = resolve; }));
  initializeWorkerDrainLanes(['0', '1']);
  const runs = [0, 1].map((index) => supervisePipelineLoop(async () => {
    calls[index]++; if (calls[index] === 1) await barriers[index]; else await delay(1);
  }, { signal: controller.signal, shouldStop: async () => false, shouldDrain: workerDrainRequested,
    onDrainState: (held) => setWorkerLaneDrained(String(index), held), canRun: () => true,
    wait: async () => { await delay(5); }, onError: (error) => { throw error; } }));
  try {
    await until(() => calls.every((n) => n === 1)); c.mark();
    release[0](); await delay(30);
    assert.equal(controller.signal.aborted, false); assert.equal(workerLanesDrained(), false);
    release[1](); await until(workerLanesDrained);
    assert.deepEqual(calls, [1, 1], 'no work was claimed while at the checkpoint');
    fs.unlinkSync(path.join(c.directory, 'pipeline.json'));
    await until(() => calls.every((n) => n > 1));
    assert.equal(controller.signal.aborted, false);
  } finally { release.forEach((done) => done()); controller.abort(); await Promise.all(runs); c.cleanup(); }
});

test('a finite manual turn can finish while new Start commands are held', () => {
  const c = context('pipeline');
  try { c.mark('pipeline', false); assert.equal(workerDeploymentBlocked(), true); assert.equal(workerDrainRequested(), false); }
  finally { c.cleanup(); }
});

test('operator pause outranks handoff, and removing a marker refreshes stale acquisition stop state', async () => {
  const c = context('acquisition'); let reads = 0;
  const row = { isRunning: false, schedulePaused: false, pausedUntil: null };
  const client = { pipelineState: { findUnique: async () => { reads++; return { ...row }; } } } as unknown as PipelineStateClient;
  const now = Date.now() + 100_000;
  try {
    c.mark('pipeline', true, 'full', now + 60_000);
    assert.equal(acquisitionCanContinueDuringHandoff(now), true);
    assert.equal(await pipelineOperatorStopRequested(client, now), false);
    row.isRunning = true; fs.unlinkSync(path.join(c.directory, 'pipeline.json'));
    assert.equal(await pipelineOperatorStopRequested(client, now + 1), false);
    assert.equal(reads, 2, 'the old cached false cannot abort an unaffected acquisition task');
    row.schedulePaused = true;
    c.mark('pipeline', true, 'full', now + 60_000);
    assert.equal(await pipelineOperatorStopRequested(client, now + 4_000), true);
    row.schedulePaused = false; row.isRunning = false;
    c.mark('pipeline', true, 'full', now - 1);
    assert.equal(await pipelineOperatorStopRequested(client, now + 8_000), true);
  } finally { c.cleanup(); }
});

test('private resume requires its handoff token and retains scheduled pause semantics', async () => {
  const c = context('pipeline'); const socket = path.join(c.directory, 'control.sock');
  const starts: Array<{ scheduled: boolean; resume: boolean }> = [];
  const server = await createPipelineControlServer({ socketPath: socket, release: 'test',
    start: async (scheduled, _mode, resume) => { starts.push({ scheduled, resume }); return Response.json({ paused: true }); }, abort: () => true });
  try {
    c.mark('pipeline', true, 'full');
    assert.equal((await requestPipelineService('/start', { scheduled: false }, socket)).status, 503);
    assert.equal((await requestPipelineService('/resume', { token: randomUUID() }, socket)).status, 409);
    const resumed = await requestPipelineService('/resume', { token: c.token }, socket);
    assert.equal(resumed.status, 200); assert.equal(resumed.body.paused, true); assert.deepEqual(starts, [{ scheduled: true, resume: true }]);
    fs.writeFileSync(path.join(c.directory, 'pipeline.json'), 'broken');
    assert.equal(workerDrainRequested(), true);
    assert.equal((await requestPipelineService('/start', { scheduled: false }, socket)).status, 503);
  } finally { await server.close(); c.cleanup(); }
});
