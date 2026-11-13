import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createPipelineControlServer } from '../../src/lib/pipelineControlServer';
import { requestPipelineService } from '../../src/lib/pipelineServiceClient';

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try { const value = await read(); if (accept(value)) return value; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Timed out waiting for fixture.');
    await delay(20);
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
}

test('the production coordinator boots and stops independently with no database access', async () => {
  const directory = await mkdtemp('/tmp/cd-coordinator-');
  const socketPath = path.join(directory, 'control.sock');
  const worker = spawn(process.execPath, ['--import', 'tsx', 'scripts/workers/pipeline-coordinator.ts'], {
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://build:build@127.0.0.1:1/build',
      DATABASE_RUNTIME_HOST: '127.0.0.1', PIPELINE_CONTROL_SOCKET: socketPath, ATS_WORKER_RELEASE_ID: 'a'.repeat(40) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = ''; worker.stderr?.on('data', (chunk) => { diagnostics += chunk; });
  try {
    const result = await waitFor(() => requestPipelineService('/health', {}, socketPath), (r) => r.status === 200);
    assert.equal(result.body.pid, worker.pid);
    assert.equal(result.body.release, 'a'.repeat(40));
    await stop(worker);
    assert.equal(worker.exitCode, 0, diagnostics);
  } finally { await stop(worker); await rm(directory, { recursive: true, force: true }); }
});

test('a running coordinator keeps its PID and saved progress through a real web process replacement and rollback', async () => {
  const directory = await mkdtemp(path.join('/tmp', 'cd-pipeline-'));
  const socketPath = path.join(directory, 'control.sock');
  const progressPath = path.join(directory, 'progress.json');
  const children: ChildProcess[] = [];
  const serverModule = path.resolve('src/lib/pipelineControlServer.ts');
  const webRoute = path.resolve('src/app/api/pipeline/run/route.ts');
  try {
    // The control server is the production implementation. A bounded fake
    // job supplies inspectable progress without touching any real database.
    const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { createPipelineControlServer } from ${JSON.stringify(serverModule)};
      import fs from 'node:fs';
      let running = false, position = 0;
      const timer = setInterval(() => { if (running) fs.writeFileSync(${JSON.stringify(progressPath)}, JSON.stringify({ position: ++position, pid: process.pid })); }, 15);
      const server = await createPipelineControlServer({ socketPath: ${JSON.stringify(socketPath)}, release: 'worker-A',
        start: async () => { if (running) return Response.json({message:'Pipeline already running'}, {status:400}); running=true; return Response.json({message:'Pipeline started in background'}); },
        abort: () => { running=false; return true; }
      });
      process.on('SIGTERM', () => { clearInterval(timer); server.close().then(() => process.exit(0)); });
    `], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(worker);
    let diagnostics = ''; worker.stderr?.on('data', (chunk) => { diagnostics += chunk; });
    await waitFor(() => requestPipelineService('/health', {}, socketPath), (r) => r.status === 200);
    const workerPid = worker.pid;
    const startWeb = async () => {
      const web = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { createServer } from 'node:http';
        import { POST } from ${JSON.stringify(webRoute)};
        const server = createServer(async (_req, res) => {
          const result = await POST(new Request('http://localhost/api/pipeline/run', {method:'POST'}));
          res.writeHead(result.status, {'content-type':'application/json'}); res.end(await result.text());
        });
        server.listen(0, '127.0.0.1', () => process.send({port:server.address().port}));
        process.on('SIGTERM', () => server.close(() => process.exit(0)));
      `], { env: { ...process.env, PIPELINE_EXECUTION_MODE: 'service', PIPELINE_CONTROL_SOCKET: socketPath },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(web);
      const port = await new Promise<number>((resolve, reject) => {
        web.once('message', (message) => resolve((message as { port: number }).port));
        web.once('error', reject);
        web.once('exit', (code) => reject(new Error(`Web fixture exited ${code}: ${diagnostics}`)));
      });
      return { web, url: `http://127.0.0.1:${port}` };
    };
    const original = await startWeb();
    assert.equal((await fetch(original.url, { method: 'POST' })).status, 200);
    const readProgress = async () => JSON.parse(await readFile(progressPath, 'utf8')) as { position: number; pid: number };
    let progress = await waitFor(readProgress, (r) => r.position > 0);
    for (const operation of ['replacement', 'rollback']) {
      await stop(children[children.length - 1]);
      const next = await startWeb();
      assert.equal((await fetch(next.url, { method: 'POST' })).status, 400, `${operation} cannot start a duplicate`);
      const previous = progress.position;
      progress = await waitFor(readProgress, (r) => r.position > previous);
      assert.equal(progress.pid, workerPid);
      assert.equal((await requestPipelineService('/health', {}, socketPath)).body.release, 'worker-A');
    }
    await requestPipelineService('/abort', {}, socketPath);
    await delay(50);
    const stopped = await readProgress();
    await delay(50);
    assert.deepEqual(await readProgress(), stopped, 'Stop reaches the independent process');
    await stop(worker);
    // A web route has no inline fallback when its worker is unavailable.
    const priorMode = process.env.PIPELINE_EXECUTION_MODE;
    const priorSocket = process.env.PIPELINE_CONTROL_SOCKET;
    try {
      process.env.PIPELINE_EXECUTION_MODE = 'service'; process.env.PIPELINE_CONTROL_SOCKET = socketPath;
      const { POST } = await import('../../src/app/api/pipeline/run/route');
      assert.equal((await POST(new Request('http://localhost/api/pipeline/run', { method: 'POST' }))).status, 503);
    } finally {
      if (priorMode === undefined) delete process.env.PIPELINE_EXECUTION_MODE; else process.env.PIPELINE_EXECUTION_MODE = priorMode;
      if (priorSocket === undefined) delete process.env.PIPELINE_CONTROL_SOCKET; else process.env.PIPELINE_CONTROL_SOCKET = priorSocket;
    }
    assert.equal(diagnostics, '');
  } finally {
    await Promise.all(children.map(stop));
    await rm(directory, { recursive: true, force: true });
  }
});

test('the private endpoint rejects duplicate servers and malformed Start commands', async () => {
  const directory = await mkdtemp(path.join('/tmp', 'cd-control-'));
  const socketPath = path.join(directory, 'control.sock');
  const modes: string[] = [];
  const options = { socketPath, release: 'test', start: async (_scheduled: boolean, mode: string) => { modes.push(mode); return Response.json({ ok: true }); }, abort: () => true };
  const server = await createPipelineControlServer(options);
  try {
    await assert.rejects(createPipelineControlServer(options), /already listening/);
    assert.equal((await requestPipelineService('/start', { scheduled: 'false' }, socketPath)).status, 400);
    assert.equal((await requestPipelineService('/start', { scheduled: true }, socketPath)).status, 200);
    assert.equal((await requestPipelineService('/start', { scheduled: true, mode: 'local' }, socketPath)).status, 400);
    assert.equal((await requestPipelineService('/start', { scheduled: false, mode: 'unknown' }, socketPath)).status, 400);
    assert.equal((await requestPipelineService('/start', { scheduled: false, mode: ['full'] }, socketPath)).status, 400);
    for (const mode of ['local', 'extraction']) {
      assert.equal((await requestPipelineService('/start', { scheduled: false, mode }, socketPath)).status, 200);
    }
    assert.deepEqual(modes, ['full', 'local', 'extraction']);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a regular control-path file is preserved rather than replaced', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cd-control-file-'));
  const socketPath = path.join(directory, 'control.sock');
  await writeFile(socketPath, 'preserved');
  try {
    await assert.rejects(createPipelineControlServer({ socketPath, release: 'test', start: async () => Response.json({}), abort: () => false }), /Refusing/);
    assert.equal(await readFile(socketPath, 'utf8'), 'preserved');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
