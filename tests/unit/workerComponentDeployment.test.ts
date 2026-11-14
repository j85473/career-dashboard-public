import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { requestPipelineService } from '../../src/lib/pipelineServiceClient';
import { ComponentDeployment } from '../../scripts/deployment/roll-worker-components.mjs';
import { WORKER_COMPONENTS, deploymentPaths } from '../../scripts/deployment/worker-components.mjs';
import { atomicWrite, capturePins, componentStatePath, installComponent, planComponentActivation,
  restorePins } from '../../scripts/deployment/worker-component-state.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), environment = 'f'.repeat(64);
function fixture(changed: string[] = ['acquisition']) {
  const directory = fs.mkdtempSync('/tmp/cd-component-');
  const paths = deploymentPaths(directory);
  const groups = Object.keys(WORKER_COMPONENTS);
  for (const revision of [A, B]) {
    const release = path.join(paths.releases, revision);
    fs.mkdirSync(path.join(release, 'scripts/deployment/m70'), { recursive: true });
    fs.writeFileSync(path.join(release, '.release-id'), revision);
    fs.writeFileSync(path.join(release, '.worker-release.json'), JSON.stringify({ version: 2, release: revision,
      inputsHash: 'c'.repeat(64), workerGroups: { protocol: 1, coordinationHash: 'd'.repeat(64), components:
        Object.fromEntries(groups.map((name) => [name, { inputsHash: (revision === B && changed.includes(name) ? 'e' : 'c').repeat(64) }])) } }));
    for (const component of Object.values(WORKER_COMPONENTS)) {
      for (const unit of component.units) {
        for (const suffix of ['service', 'timer']) {
          const source = path.resolve('scripts/deployment/m70', `${unit}.${suffix}`);
          if (fs.existsSync(source)) fs.copyFileSync(source, path.join(release, 'scripts/deployment/m70', `${unit}.${suffix}`));
        }
      }
    }
  }
  for (const group of groups) installComponent(group, path.join(paths.releases, A), environment, paths);
  fs.symlinkSync(path.join(paths.releases, A), paths.web);
  return { directory, paths, candidate: path.join(paths.releases, B),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function runtime(f: ReturnType<typeof fixture>, settings: { failStart?: boolean; failWeb?: boolean; blocked?: boolean; pause?: boolean; manual?: boolean; staleAck?: boolean } = {}) {
  const commands: string[] = [];
  const states = new Map<string, { active: boolean; pid: number }>();
  let clock = Date.now(), nextPid = 300, busy = 2, mode: string | null = settings.manual ? 'local' : 'full';
  let paused = false, failedStart = false;
  for (const [name, definition] of Object.entries(WORKER_COMPONENTS)) {
    for (const unit of definition.units) {
      states.set(`${unit}.service`, { active: ['pipeline', 'acquisition'].includes(name) && definition.units[0] === unit, pid: ++nextPid });
      if (fs.existsSync(path.join(f.paths.units, `${unit}.timer`))) states.set(`${unit}.timer`, { active: true, pid: 0 });
    }
  }
  const marker = (name: string) => path.join(f.paths.runtime, 'worker-drain', `${name}.json`);
  const stateReceipt = () => {
    const current = states.get('career-dashboard-acquisition.service')!;
    if (!current.active) return;
    const selected = JSON.parse(fs.readFileSync(componentStatePath(f.paths), 'utf8')).groups.acquisition.release;
    fs.mkdirSync(path.join(f.paths.runtime, 'worker-drain'), { recursive: true });
    atomicWrite(path.join(f.paths.runtime, 'worker-drain/acquisition.status.json'), JSON.stringify({
      version: 1, pid: current.pid, release: selected, drained: fs.existsSync(marker('acquisition')) && busy === 0, at: clock,
      handoffToken: settings.staleAck ? randomUUID() : fs.existsSync(marker('acquisition')) ? JSON.parse(fs.readFileSync(marker('acquisition'), 'utf8')).token : null }));
  };
  stateReceipt();
  const command = (program: string, args: string[], optional = false) => {
    commands.push(`${program} ${args.join(' ')}`);
    if (program === 'curl') return settings.failWeb ? '' : '{"ok":true}';
    if (program !== 'systemctl') throw new Error('Unexpected command: ' + program);
    const [action, unit] = args;
    const current = states.get(unit) || { active: false, pid: 0 };
    if (action === 'show') return `ActiveState=${current.active ? 'active' : 'inactive'}\nMainPID=${current.active ? current.pid : 0}\nDropInPaths=\n`;
    if (action === 'daemon-reload') return '';
    if (action === 'stop') {
      if (unit === 'career-dashboard-acquisition.service') assert.equal(busy, 0, 'no in-flight acquisition task is killed');
      states.set(unit, { active: false, pid: current.pid });
      if (unit === 'career-dashboard-pipeline.service') mode = null;
      return '';
    }
    if (action === 'start') {
      const selected = JSON.parse(fs.readFileSync(componentStatePath(f.paths), 'utf8')).groups.acquisition.release;
      if (settings.failStart && !failedStart && unit === 'career-dashboard-acquisition.service' && selected === B) {
        failedStart = true; throw new Error('Injected new-worker startup failure');
      }
      states.set(unit, { active: true, pid: ++nextPid }); stateReceipt(); return '';
    }
    if (optional) return '';
    throw new Error('Unexpected systemctl action');
  };
  const pipeline = async (pathname: string, body: Record<string, unknown> = {}) => {
    const selected = JSON.parse(fs.readFileSync(componentStatePath(f.paths), 'utf8')).groups.pipeline.release;
    if (pathname === '/resume') {
      commands.push('pipeline resume');
      const handoff = JSON.parse(fs.readFileSync(marker('pipeline'), 'utf8'));
      assert.equal(body.token, handoff.token); assert.equal(handoff.resumeMode, 'full');
      if (!paused) mode = 'full';
      return { status: 200, body: { paused } };
    }
    return { status: 200, body: { ok: true, protocol: 2, release: selected, running: mode !== null, mode,
      drained: mode === null || (fs.existsSync(marker('pipeline')) && busy === 0 && mode === 'full') } };
  };
  const engine = new ComponentDeployment(f.paths, { command, pipeline, own: () => {}, log: () => {}, timeoutMs: 5_000, environmentHash: () => environment,
    now: () => clock, prepareDirectory: (name: string) => fs.mkdirSync(name, { recursive: true }),
    sleep: async () => {
      clock += 1_000;
      if (!settings.blocked) busy = Math.max(0, busy - 1);
      if (settings.pause && busy === 0) paused = true;
      if (settings.manual && busy === 0) mode = null;
      stateReceipt();
    } });
  return { engine, commands, states, paused: () => paused };
}

test('component proof selects affected workers and supports independent mixed release pins', async () => {
  const f = fixture();
  try {
    const plan = planComponentActivation(f.candidate, environment, f.paths);
    assert.equal(plan.mode, 'rolling'); assert.deepEqual(plan.changed, ['acquisition']);
    const r = runtime(f); const pipelinePid = r.states.get('career-dashboard-pipeline.service')!.pid;
    await r.engine.activate(plan, f.candidate);
    const state = JSON.parse(fs.readFileSync(componentStatePath(f.paths), 'utf8'));
    assert.equal(state.groups.pipeline.release, A); assert.equal(state.groups.acquisition.release, B);
    assert.equal(r.states.get('career-dashboard-pipeline.service')!.pid, pipelinePid);
    assert.ok(!r.commands.some((line) => /(?:stop|start) career-dashboard-(?:pipeline|watchdog|public-http)/.test(line)));
    assert.equal(planComponentActivation(f.candidate, environment, f.paths).mode, 'web');
  } finally { f.cleanup(); }
});

test('a compatible web update leaves an intentionally stopped coordinator stopped', async () => {
  const f = fixture([]);
  try {
    const r = runtime(f); r.states.get('career-dashboard-pipeline.service')!.active = false;
    await r.engine.activate(planComponentActivation(f.candidate, environment, f.paths), f.candidate);
    assert.equal(r.states.get('career-dashboard-pipeline.service')!.active, false);
    assert.ok(!r.commands.includes('systemctl start career-dashboard-pipeline.service'));
  } finally { f.cleanup(); }
});

for (const component of ['pipeline', 'acquisition', 'public-http'] as const) {
  for (const failure of ['unreadable', 'unknown']) {
    test(`${failure} ${component} service state refuses handoff without changing its pin or stopping work`, async () => {
      const f = fixture([component]);
      try {
        const r = runtime(f); const command = r.engine.command;
        const unit = WORKER_COMPONENTS[component].units[0] + '.service';
        r.states.get(unit)!.active = true;
        const before = capturePins(f.paths);
        r.engine.command = (program: string, args: string[], optional = false) => {
          if (program === 'systemctl' && args[0] === 'show' && args[1] === unit) {
            if (failure === 'unknown') return 'ActiveState=unexpected\n';
            if (optional) return '';
            throw new Error('Service state unavailable');
          }
          return command(program, args, optional);
        };
        await assert.rejects(r.engine.activate(planComponentActivation(f.candidate, environment, f.paths), f.candidate));
        assert.deepEqual(capturePins(f.paths), before);
        assert.equal(r.states.get(unit)!.active, true);
        assert.ok(!r.commands.includes(`systemctl stop ${unit}`));
        assert.equal(fs.realpathSync(f.paths.web), fs.realpathSync(path.join(f.paths.releases, A)));
      } finally { f.cleanup(); }
    });
  }
}

test('a refreshing service remains busy until its current work finishes', () => {
  const f = fixture(['public-http']);
  try {
    const r = runtime(f);
    r.engine.command = () => 'ActiveState=refreshing\n';
    assert.equal(r.engine.active('career-dashboard-public-http.service'), true);
  } finally { f.cleanup(); }
});

for (const sameRevision of [false, true]) {
  for (const setting of ['unchanged', 'changed', 'missing baseline']) {
    test(`${sameRevision ? 'same' : 'new'} revision selection preserves its worker settings baseline when settings are ${setting}`, () => {
      const f = fixture();
      try {
        const baselinePath = componentStatePath(f.paths);
        const state = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        if (setting === 'missing baseline') delete state.groups.acquisition.environmentHash;
        fs.writeFileSync(baselinePath, JSON.stringify(state));
        const baseline = fs.readFileSync(baselinePath, 'utf8');
        const selectedEnvironment = setting === 'changed' ? '0'.repeat(64) : environment;
        const plan = planComponentActivation(path.join(f.paths.releases, sameRevision ? A : B), selectedEnvironment, f.paths);
        assert.equal(plan.mode === 'coordinated', setting !== 'unchanged');
        assert.equal(fs.readFileSync(baselinePath, 'utf8'), baseline, 'selection never rewrites the running baseline');
      } finally { f.cleanup(); }
    });
  }
}

for (const failWeb of [false, true]) {
  test(`failed ${failWeb ? 'web health' : 'worker start'} restores affected pins and leaves peer processes alone`, async () => {
    const f = fixture();
    try {
      const r = runtime(f, failWeb ? { failWeb: true } : { failStart: true });
      const pid = r.states.get('career-dashboard-pipeline.service')!.pid;
      await assert.rejects(r.engine.activate(planComponentActivation(f.candidate, environment, f.paths), f.candidate));
      assert.equal(fs.realpathSync(f.paths.web), fs.realpathSync(path.join(f.paths.releases, A)));
      const state = JSON.parse(fs.readFileSync(componentStatePath(f.paths), 'utf8'));
      assert.ok(Object.values(state.groups).every((value) => (value as { release: string }).release === A));
      assert.equal(r.states.get('career-dashboard-pipeline.service')!.pid, pid);
      assert.equal(JSON.parse(fs.readFileSync(r.engine.journalPath(), 'utf8')).status, 'rolled-back');
    } finally { f.cleanup(); }
  });
}

test('a checkpoint timeout releases the hold without killing or replacing the old worker', async () => {
  const f = fixture();
  try {
    const r = runtime(f, { blocked: true });
    await assert.rejects(r.engine.activate(planComponentActivation(f.candidate, environment, f.paths), f.candidate), /Checkpoint wait expired/);
    assert.ok(!r.commands.some((line) => line === 'systemctl stop career-dashboard-acquisition.service'));
    assert.equal(fs.realpathSync(path.join(f.paths.pins, 'acquisition')), fs.realpathSync(path.join(f.paths.releases, A)));
    assert.ok(!fs.existsSync(r.engine.marker('acquisition')));
  } finally { f.cleanup(); }
});

test('a receipt from a different handoff cannot authorize stopping a worker', async () => {
  const f = fixture();
  try {
    const r = runtime(f, { staleAck: true });
    await assert.rejects(r.engine.activate(planComponentActivation(f.candidate, environment, f.paths), f.candidate), /Checkpoint wait expired/);
    assert.ok(!r.commands.includes('systemctl stop career-dashboard-acquisition.service'));
  } finally { f.cleanup(); }
});

test('a coordinator handoff honors a Stop pressed during the update', async () => {
  const f = fixture(['pipeline']);
  try {
    const r = runtime(f, { pause: true }); const acquisitionPid = r.states.get('career-dashboard-acquisition.service')!.pid;
    await r.engine.activate(planComponentActivation(f.candidate, environment, f.paths), f.candidate);
    assert.equal(r.paused(), true);
    assert.ok(r.commands.includes('pipeline resume'));
    assert.equal(r.states.get('career-dashboard-acquisition.service')!.pid, acquisitionPid);
  } finally { f.cleanup(); }
});

test('a failed coordinator startup preserves the technical handoff through rollback so acquisition can continue', async () => {
  const f = fixture(['pipeline']);
  try {
    const r = runtime(f); const command = r.engine.command;
    const acquisitionPid = r.states.get('career-dashboard-acquisition.service')!.pid;
    let failedStart = false, heldChecks = 0;
    r.engine.command = (program: string, args: string[], optional = false) => {
      if (!r.states.get('career-dashboard-pipeline.service')!.active) {
        const handoff = JSON.parse(fs.readFileSync(r.engine.marker('pipeline'), 'utf8'));
        assert.equal(handoff.resumeMode, 'full', 'unaffected acquisition retains its technical handoff'); heldChecks++;
      }
      if (program === 'systemctl' && args[0] === 'start' && args[1] === 'career-dashboard-pipeline.service'
        && !failedStart && JSON.parse(fs.readFileSync(componentStatePath(f.paths), 'utf8')).groups.pipeline.release === B) {
        failedStart = true; throw new Error('Injected coordinator startup failure');
      }
      return command(program, args, optional);
    };
    await assert.rejects(r.engine.activate(planComponentActivation(f.candidate, environment, f.paths), f.candidate), /Injected coordinator startup failure/);
    assert.ok(heldChecks > 0); assert.ok(r.states.get('career-dashboard-pipeline.service')!.active);
    assert.equal(r.states.get('career-dashboard-acquisition.service')!.pid, acquisitionPid);
    assert.equal(JSON.parse(fs.readFileSync(r.engine.journalPath(), 'utf8')).status, 'rolled-back');
    assert.ok(!fs.existsSync(r.engine.marker('pipeline')));
  } finally { f.cleanup(); }
});

test('missing or malformed component fingerprints cannot authorize a selective release', () => {
  const f = fixture([]);
  try {
    for (const revision of [A, B]) {
      const filename = path.join(f.paths.releases, revision, '.worker-release.json');
      const original = fs.readFileSync(filename, 'utf8');
      for (const invalid of [undefined, { inputsHash: 'unverified' }]) {
        const manifest = JSON.parse(original); manifest.workerGroups.components.acquisition = invalid;
        fs.writeFileSync(filename, JSON.stringify(manifest));
        assert.equal(planComponentActivation(f.candidate, environment, f.paths).mode, 'coordinated');
      }
      fs.writeFileSync(filename, original);
    }
  } finally { f.cleanup(); }
});

test('finite manual runs finish once and are not restarted with a fresh pass budget', async () => {
  const f = fixture(['pipeline']);
  try {
    const r = runtime(f, { manual: true });
    await r.engine.activate(planComponentActivation(f.candidate, environment, f.paths), f.candidate);
    assert.ok(!r.commands.includes('pipeline resume'));
  } finally { f.cleanup(); }
});

test('interrupted activation recovers only the worker group that had been switched', async () => {
  const f = fixture();
  try {
    const r = runtime(f); const pins = capturePins(f.paths);
    const activity = r.engine.activities('acquisition');
    installComponent('acquisition', f.candidate, environment, f.paths);
    r.engine.save({ version: 1, status: 'running', release: B, token: randomUUID(), oldWeb: path.join(f.paths.releases, A),
      pins, steps: [{ component: 'acquisition', phase: 'starting', activity, resumeMode: null }], webTouched: false });
    await r.engine.recoverPending();
    assert.equal(JSON.parse(fs.readFileSync(componentStatePath(f.paths), 'utf8')).groups.acquisition.release, A);
    assert.ok(!r.commands.some((line) => line === 'systemctl stop career-dashboard-pipeline.service'));
  } finally { f.cleanup(); }
});

test('settings, shared coordination, unsupported worker changes and incomplete proof retain full activation', () => {
  const f = fixture(['platform']);
  try {
    assert.equal(planComponentActivation(f.candidate, environment, f.paths).mode, 'coordinated');
    assert.equal(planComponentActivation(f.candidate, '0'.repeat(64), f.paths).mode, 'coordinated');
    const manifest = JSON.parse(fs.readFileSync(path.join(f.candidate, '.worker-release.json'), 'utf8'));
    manifest.workerGroups.coordinationHash = '0'.repeat(64);
    fs.writeFileSync(path.join(f.candidate, '.worker-release.json'), JSON.stringify(manifest));
    assert.equal(planComponentActivation(f.candidate, environment, f.paths).mode, 'coordinated');
    fs.unlinkSync(componentStatePath(f.paths));
    assert.equal(planComponentActivation(f.candidate, environment, f.paths).mode, 'coordinated');
  } finally { f.cleanup(); }
});

test('a coordinated rollback restores all independent pins, settings baselines and unit files', () => {
  const f = fixture();
  try {
    const original = capturePins(f.paths);
    for (const group of Object.keys(WORKER_COMPONENTS)) installComponent(group, f.candidate, '0'.repeat(64), f.paths);
    restorePins(original, f.paths);
    assert.deepEqual(capturePins(f.paths), original);
  } finally { f.cleanup(); }
});

test('coordinated rollback preserves mixed pins even when failure happens before installing the candidate', () => {
  const activation = fs.readFileSync('scripts/deployment/activate-m70.sh', 'utf8');
  const trap = activation.indexOf('trap recover ERR');
  const snapshot = activation.indexOf('roll-worker-components.mjs" snapshot');
  assert.ok(snapshot > 0 && snapshot < trap, 'original pins are saved before any guarded step can fail');
  const recovery = activation.slice(activation.indexOf('recover() {'), trap);
  assert.match(recovery, /WORKER_PINS_SNAPSHOTTED/);
  assert.doesNotMatch(recovery, /WORKER_PINS_CHANGED/);
  assert.ok(recovery.indexOf('roll-worker-components.mjs" restore') < recovery.indexOf('systemctl daemon-reload'));
});

test('interrupted releases have a boot and timer recovery owner that defers to live deployment and backup locks', () => {
  const service = fs.readFileSync('scripts/deployment/m70/career-dashboard-worker-recovery.service', 'utf8');
  const timer = fs.readFileSync('scripts/deployment/m70/career-dashboard-worker-recovery.timer', 'utf8');
  assert.match(service, /flock -n -E 0 --no-fork \/var\/lib\/career-dashboard\/deploy.lock/);
  assert.match(service, /flock -n -E 0 --no-fork \/var\/lib\/career-dashboard\/backup.lock/);
  assert.match(service, /roll-worker-components.mjs recover/);
  assert.match(timer, /OnBootSec=90s/); assert.match(timer, /OnCalendar=minutely/); assert.match(timer, /Persistent=true/);
  assert.match(service, /StartLimitIntervalSec=0/, 'routine successful checks cannot exhaust recovery start limits');
});

test('real worker replacement preserves completed task IDs while a separate coordinator keeps making progress', async () => {
  const f = fixture(); const children: ChildProcess[] = []; const commands: string[] = [];
  const drainDirectory = path.join(f.paths.runtime, 'worker-drain'); fs.mkdirSync(drainDirectory, { recursive: true });
  const socket = path.join(f.directory, 'pipeline.sock');
  const progress = path.join(f.directory, 'coordinator.json'), jobs = path.join(f.directory, 'jobs.json');
  const owner = path.join(f.directory, 'acquisition.owner');
  const helper = path.resolve('src/lib/workerDeployment.ts'), supervisor = path.resolve('src/lib/pipelineLoopSupervisor.ts');
  let diagnostics = '';
  const launch = (code: string, release: string, component: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      env: { ...process.env, CAREER_WORKER_COMPONENT: component, ATS_WORKER_RELEASE_ID: release,
        WORKER_DRAIN_DIRECTORY: drainDirectory }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (data) => { diagnostics += data; }); children.push(child); return child;
  };
  const poll = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!await check()) { if (Date.now() > deadline) throw new Error('Process fixture timeout: ' + diagnostics); await delay(10); }
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
  };
  const acquisitionCode = `
    import fs from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    import {initializeWorkerDrainLanes, setWorkerLaneDrained, workerDrainRequested, workerLanesDrained, writeWorkerDeploymentStatus} from ${JSON.stringify(helper)};
    import {supervisePipelineLoop} from ${JSON.stringify(supervisor)};
    const owner=${JSON.stringify(owner)}, filename=${JSON.stringify(jobs)};
    fs.writeFileSync(owner, String(process.pid), {flag:'wx'});
    const state=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{next:0,completed:[],interrupted:false};
    const active=new Set(), controller=new AbortController();
    const save=()=>{fs.writeFileSync(filename+'.tmp',JSON.stringify(state));fs.renameSync(filename+'.tmp',filename);};
    initializeWorkerDrainLanes(['0','1']);
    const runs=[0,1].map(index=>supervisePipelineLoop(async()=>{
      const id=++state.next;active.add(id);save();await delay(20);state.completed.push(id);active.delete(id);save();
    },{signal:controller.signal,shouldStop:async()=>false,shouldDrain:workerDrainRequested,
       onDrainState:held=>setWorkerLaneDrained(String(index),held),canRun:()=>true,
       wait:async()=>delay(10),onError:error=>{throw error;}}));
    const status=setInterval(()=>writeWorkerDeploymentStatus(workerLanesDrained()),10);
    process.on('SIGTERM',async()=>{if(active.size)state.interrupted=true;controller.abort();await Promise.all(runs);clearInterval(status);save();fs.unlinkSync(owner);process.exit(0);});
  `;
  const coordinator = launch(`
    import fs from 'node:fs';
    import {createPipelineControlServer} from ${JSON.stringify(path.resolve('src/lib/pipelineControlServer.ts'))};
    let position=0;
    const timer=setInterval(()=>{fs.writeFileSync(${JSON.stringify(progress + '.tmp')},JSON.stringify({pid:process.pid,position:++position}));fs.renameSync(${JSON.stringify(progress + '.tmp')},${JSON.stringify(progress)});},10);
    const server=await createPipelineControlServer({socketPath:${JSON.stringify(socket)},release:${JSON.stringify(A)},
      start:async()=>Response.json({}),abort:()=>false,workState:()=>({running:true,mode:'full',drained:false})});
    process.on('SIGTERM',()=>{clearInterval(timer);server.close().then(()=>process.exit(0));});
  `, A, 'pipeline');
  let acquisition: ChildProcess | null = launch(acquisitionCode, A, 'acquisition');
  try {
    await poll(async () => { try { return (await requestPipelineService('/health', {}, socket)).status === 200; } catch { return false; } });
    await poll(() => fs.existsSync(path.join(drainDirectory, 'acquisition.status.json')) && fs.existsSync(jobs));
    const before = JSON.parse(fs.readFileSync(jobs, 'utf8'));
    const coordinatorBefore = JSON.parse(fs.readFileSync(progress, 'utf8'));
    const oldAcquisitionPid = acquisition.pid;
    const engine = new ComponentDeployment(f.paths, { environmentHash: () => environment,
      own: () => {}, log: () => {}, timeoutMs: 10_000, sleep: async () => delay(10),
      prepareDirectory: (name: string) => fs.mkdirSync(name, { recursive: true }),
      pipeline: (pathname: '/health' | '/resume', body: Record<string, unknown> = {}) => requestPipelineService(pathname, body, socket),
      command: (program: string, args: string[]) => {
        commands.push(`${program} ${args.join(' ')}`);
        if (program === 'curl') return '{"ok":true}';
        assert.equal(program, 'systemctl');
        if (args[0] === 'show') {
          const child = args[1] === 'career-dashboard-acquisition.service' ? acquisition
            : args[1] === 'career-dashboard-pipeline.service' ? coordinator : null;
          return `ActiveState=${child ? 'active' : 'inactive'}\nMainPID=${child?.pid || 0}\n`;
        }
        if (args[0] === 'stop' && args[1] === 'career-dashboard-acquisition.service') {
          // systemctl waits for the owner to release its leases. The external
          // waiter lets the test parent block while both child processes run.
          execFileSync(process.execPath, ['-e', `
            const fs=require('node:fs');process.kill(${acquisition!.pid},'SIGTERM');const end=Date.now()+5000;
            while(fs.existsSync(${JSON.stringify(owner)})){if(Date.now()>end)process.exit(1);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}
          `]);
          acquisition = null;
        } else if (args[0] === 'start' && args[1] === 'career-dashboard-acquisition.service') {
          const revision = JSON.parse(fs.readFileSync(componentStatePath(f.paths), 'utf8')).groups.acquisition.release;
          acquisition = launch(acquisitionCode, revision, 'acquisition');
        } else assert.ok(args[0] === 'daemon-reload' || args[1] === 'career-dashboard.service', 'unaffected worker was controlled');
        return '';
      },
    });
    await engine.activate(planComponentActivation(f.candidate, environment, f.paths), f.candidate);
    await poll(() => JSON.parse(fs.readFileSync(jobs, 'utf8')).completed.length > before.completed.length + 2);
    const after = JSON.parse(fs.readFileSync(jobs, 'utf8'));
    assert.notEqual(acquisition!.pid, oldAcquisitionPid);
    assert.equal(after.interrupted, false); assert.equal(new Set(after.completed).size, after.completed.length);
    assert.ok(before.completed.every((id: number) => after.completed.includes(id)));
    const coordinatorAfter = JSON.parse(fs.readFileSync(progress, 'utf8'));
    assert.equal(coordinatorAfter.pid, coordinatorBefore.pid); assert.ok(coordinatorAfter.position > coordinatorBefore.position);
    assert.ok(!commands.includes('systemctl stop career-dashboard-pipeline.service'));
    assert.equal(diagnostics, '');
  } finally { await Promise.all(children.map(stop)); f.cleanup(); }
});
