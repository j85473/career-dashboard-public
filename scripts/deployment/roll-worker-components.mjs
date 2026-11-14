import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse as parseEnvironment } from 'dotenv';
import { setTimeout as delay } from 'node:timers/promises';
import { WORKER_COMPONENTS, COMPONENT_PROTOCOL, deploymentPaths } from './worker-components.mjs';
import { atomicWrite, atomicLink, capturePins, componentStatePath, ensureDeploymentState, installComponent,
  ownWorkerFile, planComponentActivation, readOptional, restoreComponent, restorePins } from './worker-component-state.mjs';
import { workerEnvironmentFingerprint } from './worker-environment-fingerprint.mjs';
import { requestPipelineService, PIPELINE_CONTROL_PROTOCOL } from '../../src/lib/pipelineServiceClient.ts';

export function systemCommand(command, args, optional = false) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 }); }
  catch (error) { if (optional) return ''; throw new Error(`${command} ${args[0]} failed: ${error.stderr?.toString().slice(-1000) || error.message}`); }
}

export class ComponentDeployment {
  constructor(paths = deploymentPaths(), options = {}) {
    this.paths = paths; this.command = options.command || systemCommand; this.sleep = options.sleep || delay;
    this.now = options.now || Date.now; this.own = options.own || ownWorkerFile;
    this.pipeline = options.pipeline || ((pathname, body = {}) => requestPipelineService(pathname, body));
    this.log = options.log || console.log; this.timeout = options.timeoutMs || 60 * 60 * 1000;
    this.environmentHash = options.environmentHash || (() => workerEnvironmentFingerprint(paths.config));
    this.prepareDirectory = options.prepareDirectory || ((directory) => {
      fs.mkdirSync(directory, { recursive: true }); this.command('chown', ['career-dashboard:career-dashboard', directory]); fs.chmodSync(directory, 0o700);
    });
    ensureDeploymentState(paths);
  }
  journalPath() { return path.join(this.paths.state, 'component-deployment.json'); }
  save(journal) { atomicWrite(this.journalPath(), JSON.stringify(journal)); }
  show(unit) {
    const state = Object.fromEntries(this.command('systemctl', ['show', unit,
      '--property=ActiveState,SubState,MainPID,Result,NRestarts,WorkingDirectory,DropInPaths,Job'])
      .trim().split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    if (!['inactive', 'failed', 'active', 'activating', 'deactivating', 'reloading', 'refreshing'].includes(state.ActiveState)) {
      throw new Error(`Could not establish whether ${unit} is idle: ${state.ActiveState || 'unreadable state'}.`);
    }
    return state;
  }
  active(unit) {
    const state = this.show(unit);
    return ['active', 'activating', 'deactivating', 'reloading', 'refreshing'].includes(state.ActiveState)
      || Boolean(state.Job && state.Job.split(' ')[0] !== '0');
  }
  activities(component) {
    const result = {};
    for (const name of WORKER_COMPONENTS[component].units) {
      result[`${name}.service`] = this.active(`${name}.service`);
      if (fs.existsSync(path.join(this.paths.units, `${name}.timer`))) result[`${name}.timer`] = this.active(`${name}.timer`);
    }
    return result;
  }
  marker(component) { return path.join(this.paths.runtime, 'worker-drain', `${component}.json`); }
  async waitFor(check, description, deadline) {
    let reportedAt = 0;
    while (!await check()) {
      if (this.now() >= deadline) throw new Error(`Checkpoint wait expired: ${description}. Running work was not killed.`);
      if (this.now() - reportedAt >= 30_000) {
        reportedAt = this.now(); this.log(`Waiting for ${description}; ${Math.ceil((deadline - this.now()) / 60_000)} minute(s) remain.`);
      }
      await this.sleep(250);
    }
  }
  async pipelineHealth() {
    const response = await this.pipeline('/health');
    if (response.status !== 200 || response.body.protocol !== PIPELINE_CONTROL_PROTOCOL || response.body.ok !== true) throw new Error('Pipeline control protocol is not ready.');
    return response.body;
  }
  async drain(component, activity, token, preservedResumeMode = null) {
    const definition = WORKER_COMPONENTS[component];
    const deadline = this.now() + this.timeout;
    const existing = readOptional(this.marker(component));
    if (existing !== null && JSON.parse(existing).token !== token) throw new Error('A different handoff owns this worker.');
    for (const unit of Object.keys(activity)) if (unit.endsWith('.timer')) this.command('systemctl', ['stop', unit]);
    let resumeMode = component === 'pipeline' ? preservedResumeMode : null, softDrain = definition.strategy !== 'turn';
    if (definition.strategy === 'pipeline' && this.active('career-dashboard-pipeline.service')) {
      const health = await this.pipelineHealth();
      if (health.running && health.mode === 'full') resumeMode = 'full';
      // A finite manual run completes its original invocation; restarting it
      // would reset its bounded pass count and could do extra work.
      softDrain = !health.running || health.mode === 'full';
    }
    const directory = path.dirname(this.marker(component)); this.prepareDirectory(directory);
    atomicWrite(this.marker(component), JSON.stringify({ version: 1, component, token, deadline, softDrain, resumeMode }), 0o640);
    this.own(this.marker(component));
    if (definition.strategy === 'pipeline' && this.active('career-dashboard-pipeline.service')) {
      await this.waitFor(async () => (await this.pipelineHealth()).drained === true, 'pipeline lanes finishing their current tasks', deadline);
    } else if (definition.strategy === 'acquisition' && this.active('career-dashboard-acquisition.service')) {
      await this.waitFor(() => {
        const state = this.show('career-dashboard-acquisition.service');
        const text = readOptional(path.join(this.paths.runtime, 'worker-drain', 'acquisition.status.json'));
        if (!text) return false;
        const status = JSON.parse(text);
        return status.version === 1 && status.drained === true && status.handoffToken === token && status.pid === Number(state.MainPID)
          && status.release === JSON.parse(fs.readFileSync(componentStatePath(this.paths), 'utf8')).groups.acquisition.release
          && Number.isFinite(status.at) && status.at <= this.now() + 1_000 && this.now() - status.at < 5_000;
      }, 'acquisition lanes finishing their current tasks', deadline);
    }
    for (const name of definition.units) {
      if (definition.strategy === 'pipeline' && name === 'career-dashboard-pipeline') continue;
      if (definition.strategy === 'acquisition') continue;
      await this.waitFor(() => !this.active(`${name}.service`), `${name} completing its saved turn`, deadline);
    }
    return resumeMode;
  }
  clearMarker(component, token) {
    const text = readOptional(this.marker(component));
    if (text === null) return;
    if (JSON.parse(text).token !== token) throw new Error('A different handoff owns this worker.');
    fs.unlinkSync(this.marker(component));
  }
  stopContinuous(component, activity) {
    if (['pipeline', 'acquisition'].includes(WORKER_COMPONENTS[component].strategy)) {
      const unit = WORKER_COMPONENTS[component].units[0] + '.service';
      if (activity[unit] || this.active(unit)) this.command('systemctl', ['stop', unit]);
    }
  }
  async startContinuous(component, activity, release) {
    const definition = WORKER_COMPONENTS[component];
    if (!['pipeline', 'acquisition'].includes(definition.strategy)) return;
    const unit = definition.units[0] + '.service';
    if (!activity[unit]) return;
    this.command('systemctl', ['start', unit]);
    const deadline = this.now() + 60_000;
    await this.waitFor(async () => {
      if (this.show(unit).ActiveState !== 'active') return false;
      if (definition.strategy === 'pipeline') {
        try { return (await this.pipelineHealth()).release === release; } catch { return false; }
      }
      const text = readOptional(path.join(this.paths.runtime, 'worker-drain', 'acquisition.status.json'));
      if (!text) return false;
      const status = JSON.parse(text);
      return status.version === 1 && status.release === release && status.pid === Number(this.show(unit).MainPID)
        && Number.isFinite(status.at) && status.at <= this.now() + 1_000 && this.now() - status.at < 5_000;
    }, `${component} starting on its selected release`, deadline);
  }
  restoreTimers(activity) {
    for (const [unit, wasActive] of Object.entries(activity)) if (unit.endsWith('.timer') && wasActive) this.command('systemctl', ['start', unit]);
  }
  async resumePipeline(mode, token) {
    if (mode !== 'full') return;
    const marker = JSON.parse(fs.readFileSync(this.marker('pipeline'), 'utf8'));
    if (marker.token !== token) throw new Error('Resume no longer owns its handoff.');
    marker.resumeMode = 'full'; marker.deadline = this.now() + this.timeout;
    atomicWrite(this.marker('pipeline'), JSON.stringify(marker), 0o640); this.own(this.marker('pipeline'));
    const response = await this.pipeline('/resume', { mode: 'full', token });
    if (response.status !== 200) throw new Error('Could not resume the pipeline under its preserved operator intent.');
    // Scheduled resume honors a Stop pressed during deployment. A paused
    // response is a successful preservation of that newer operator choice.
  }
  async activate(plan, directory) {
    if (!['rolling', 'web'].includes(plan.mode) || plan.version !== COMPONENT_PROTOCOL) throw new Error('Not an independent activation plan.');
    await this.recoverPending();
    const current = planComponentActivation(directory, this.environmentHash(), this.paths);
    if (current.mode !== plan.mode || current.release !== plan.release || current.environmentHash !== plan.environmentHash
      || current.changed.join() !== plan.changed.join()) throw new Error('Release compatibility changed after planning; no workers were changed.');
    const journal = { version: COMPONENT_PROTOCOL, status: 'running', release: plan.release, token: randomUUID(),
      oldWeb: fs.realpathSync(this.paths.web), pins: capturePins(this.paths), steps: [], webTouched: false,
      pipelineWasActive: this.active('career-dashboard-pipeline.service') };
    this.save(journal);
    try {
      for (const component of plan.changed) {
        this.log(`Updating ${component}; other worker groups retain their processes and release pins.`);
        const step = { component, activity: this.activities(component), phase: 'requested', resumeMode: null };
        journal.steps.push(step); this.save(journal);
        step.resumeMode = await this.drain(component, step.activity, journal.token); this.save(journal);
        if (this.environmentHash() !== plan.environmentHash) throw new Error('Worker settings changed during checkpoint drain.');
        // A durable phase precedes each mutation, so interruption recovery can
        // safely repeat the handoff without touching an unrelated group.
        step.phase = 'stopping'; this.save(journal);
        this.stopContinuous(component, step.activity);
        step.phase = 'installing'; this.save(journal);
        installComponent(component, directory, plan.environmentHash, this.paths, this.own);
        this.command('systemctl', ['daemon-reload']);
        step.phase = 'starting'; this.save(journal);
        await this.startContinuous(component, step.activity, plan.release);
        if (component === 'pipeline') await this.resumePipeline(step.resumeMode, journal.token);
        this.clearMarker(component, journal.token);
        this.restoreTimers(step.activity);
        step.phase = 'complete'; this.save(journal);
      }
      if (this.environmentHash() !== plan.environmentHash) throw new Error('Worker settings changed before web activation.');
      journal.webTouched = true; this.save(journal);
      this.command('systemctl', ['stop', 'career-dashboard.service']);
      atomicLink(directory, this.paths.web);
      this.command('systemctl', ['start', 'career-dashboard.service']);
      await this.waitFor(() => Boolean(this.command('curl', ['-fsS', '--max-time', '10',
        'http://100.107.116.123:3000/api/health'], true)), 'new web release answering health', this.now() + 120_000);
      const expected = JSON.parse(fs.readFileSync(componentStatePath(this.paths), 'utf8')).groups.pipeline.release;
      if (journal.pipelineWasActive && (await this.pipelineHealth()).release !== expected) throw new Error('Pipeline release proof changed during activation.');
      journal.status = 'complete'; this.save(journal);
      fs.writeFileSync(path.join(directory, '.m70-activation-complete'), '');
      this.log(`Activated ${plan.release}; updated ${plan.changed.join(', ') || 'web only'}.`);
    } catch (error) {
      this.log(`Independent activation failed; restoring only affected worker groups: ${error.message}`);
      await this.rollback(journal);
      throw error;
    }
  }
  async rollback(journal) {
    if (journal.version !== COMPONENT_PROTOCOL) throw new Error('Unknown worker recovery protocol.');
    journal.status = 'recovering'; this.save(journal);
    if (journal.webTouched) {
      this.command('systemctl', ['stop', 'career-dashboard.service']); atomicLink(journal.oldWeb, this.paths.web);
      this.command('systemctl', ['start', 'career-dashboard.service']);
    }
    for (const step of [...journal.steps].reverse()) {
      if (step.recovered) continue;
      if (step.phase === 'requested') {
        this.clearMarker(step.component, journal.token); this.restoreTimers(step.activity);
        step.recovered = true; this.save(journal); continue;
      }
      // A new worker may have begun work before failure. Let its current turn
      // finish under the same checkpoint rules before restoring its old pin.
      // Keep the original technical handoff continuously visible even if the
      // replacement coordinator never started. Unaffected acquisition must
      // not mistake rollback for an operator Stop.
      await this.drain(step.component, this.activities(step.component), journal.token, step.resumeMode);
      this.stopContinuous(step.component, step.activity);
      restoreComponent(step.component, journal.pins.groups[step.component], this.paths, this.own);
      this.command('systemctl', ['daemon-reload']);
      const original = JSON.parse(journal.pins.state).groups[step.component];
      // Restore this metadata before checking acquisition readiness.
      const state = JSON.parse(fs.readFileSync(componentStatePath(this.paths), 'utf8'));
      state.groups[step.component] = original; atomicWrite(componentStatePath(this.paths), JSON.stringify(state));
      await this.startContinuous(step.component, step.activity, original.release);
      if (step.component === 'pipeline') await this.resumePipeline(step.resumeMode, journal.token);
      this.clearMarker(step.component, journal.token);
      this.restoreTimers(step.activity);
      step.recovered = true; this.save(journal);
    }
    atomicWrite(componentStatePath(this.paths), journal.pins.state);
    if (journal.pins.workers) atomicLink(journal.pins.workers, this.paths.workers);
    if (journal.pins.workerEnvironment !== null) {
      const file = path.join(this.paths.config, 'acquisition-release.env'); atomicWrite(file, journal.pins.workerEnvironment, 0o640); this.own(file);
    }
    journal.status = 'rolled-back'; this.save(journal);
  }
  async recoverPending() {
    const text = readOptional(this.journalPath());
    if (text) {
      const journal = JSON.parse(text);
      if (!['complete', 'rolled-back'].includes(journal.status)) await this.rollback(journal);
    }
    const directory = path.join(this.paths.runtime, 'worker-drain');
    if (fs.existsSync(directory) && fs.readdirSync(directory).some((name) => name.endsWith('.json') && !name.endsWith('.status.json'))) {
      throw new Error('Unowned worker handoff marker remains; refusing a new activation.');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  (async () => {
    if (process.getuid?.() !== 0) throw new Error('Component activation belongs to the root-owned, locked release process.');
    const paths = deploymentPaths(); ensureDeploymentState(paths);
    // The root release/recovery caller does not inherit the worker unit's
    // environment. Honor an explicitly configured private socket without
    // loading or logging the remaining production credentials.
    if (!process.env.PIPELINE_CONTROL_SOCKET) {
      const settings = parseEnvironment(readOptional(path.join(paths.config, 'runtime.env')) || '');
      if (settings.PIPELINE_CONTROL_SOCKET) process.env.PIPELINE_CONTROL_SOCKET = settings.PIPELINE_CONTROL_SOCKET;
    }
    const [mode, argument] = process.argv.slice(2);
    if (mode === 'snapshot') atomicWrite(argument, JSON.stringify(capturePins(paths)));
    else if (mode === 'install') {
      const environmentHash = workerEnvironmentFingerprint(paths.config);
      for (const component of Object.keys(WORKER_COMPONENTS)) installComponent(component, argument, environmentHash, paths, ownWorkerFile);
    } else if (mode === 'restore') restorePins(JSON.parse(fs.readFileSync(argument, 'utf8')), paths, ownWorkerFile);
    else if (mode === 'recover') await new ComponentDeployment(paths).recoverPending();
    else if (mode === 'plan') console.log(JSON.stringify(planComponentActivation(argument, workerEnvironmentFingerprint(paths.config), paths)));
    else if (mode === 'activate') await new ComponentDeployment(paths).activate(JSON.parse(fs.readFileSync(argument, 'utf8')), process.argv[4]);
    else throw new Error('Unknown component deployment action.');
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
