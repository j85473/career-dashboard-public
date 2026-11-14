import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WORKER_COMPONENTS, COMPONENT_PROTOCOL, deploymentPaths, renderWorkerUnit } from './worker-components.mjs';
import { readManifest } from './worker-release-manifest.mjs';

export function atomicWrite(filename, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', mode);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export function atomicLink(target, filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.next`;
  fs.rmSync(temporary, { force: true }); fs.symlinkSync(target, temporary); fs.renameSync(temporary, filename);
}
export function readOptional(filename) {
  try { return fs.readFileSync(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function ensureDeploymentState(paths) {
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 }); fs.chmodSync(paths.state, 0o700);
}
export function componentStatePath(paths) { return path.join(paths.state, 'worker-component-releases.json'); }
function linkTarget(filename) {
  try { return fs.readlinkSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function componentEnvironment(component, revision) {
  return `ATS_WORKER_RELEASE_ID=${revision}\nCAREER_WORKER_COMPONENT=${component}\n`;
}
export function captureComponent(component, paths) {
  const unitFiles = {};
  for (const name of WORKER_COMPONENTS[component].units) {
    for (const suffix of ['service', 'timer']) unitFiles[`${name}.${suffix}`] = readOptional(path.join(paths.units, `${name}.${suffix}`));
  }
  return { alias: linkTarget(path.join(paths.pins, component)),
    rollback: linkTarget(path.join(paths.pins, `${component}.rollback`)),
    environment: readOptional(path.join(paths.config, 'worker-releases', `${component}.env`)), unitFiles };
}
export function capturePins(paths) {
  return { version: COMPONENT_PROTOCOL, groups: Object.fromEntries(Object.keys(WORKER_COMPONENTS).map((name) => [name, captureComponent(name, paths)])),
    state: readOptional(componentStatePath(paths)), workers: linkTarget(paths.workers),
    workerEnvironment: readOptional(path.join(paths.config, 'acquisition-release.env')) };
}
function restoreFile(filename, contents, mode = 0o600) {
  if (contents === null) fs.rmSync(filename, { force: true }); else atomicWrite(filename, contents, mode);
}
export function restoreComponent(component, snapshot, paths, own = () => {}) {
  const allowed = WORKER_COMPONENTS[component].units.flatMap((unit) => [`${unit}.service`, `${unit}.timer`]);
  if (Object.keys(snapshot.unitFiles).some((name) => !allowed.includes(name))) throw new Error('Unknown unit in recovery snapshot.');
  for (const target of [snapshot.alias, snapshot.rollback]) {
    const resolved = target == null ? null : path.resolve(paths.pins, target);
    if (resolved !== null && (path.dirname(resolved) !== paths.releases || !/^[a-f0-9]{40}$/.test(path.basename(resolved)))) throw new Error('Invalid recovery release.');
  }
  const alias = path.join(paths.pins, component);
  if (snapshot.alias === null) fs.rmSync(alias, { force: true }); else atomicLink(snapshot.alias, alias);
  if (snapshot.rollback == null) fs.rmSync(`${alias}.rollback`, { force: true }); else atomicLink(snapshot.rollback, `${alias}.rollback`);
  const env = path.join(paths.config, 'worker-releases', `${component}.env`);
  restoreFile(env, snapshot.environment, 0o640); if (snapshot.environment !== null) own(env);
  for (const [filename, contents] of Object.entries(snapshot.unitFiles)) restoreFile(path.join(paths.units, filename), contents, 0o644);
}
export function restorePins(snapshot, paths, own = () => {}) {
  if (snapshot.version !== COMPONENT_PROTOCOL || Object.keys(snapshot.groups).sort().join() !== Object.keys(WORKER_COMPONENTS).sort().join()) throw new Error('Unsupported worker recovery snapshot.');
  for (const [component, value] of Object.entries(snapshot.groups)) restoreComponent(component, value, paths, own);
  restoreFile(componentStatePath(paths), snapshot.state);
  if (snapshot.workers === null) fs.rmSync(paths.workers, { force: true }); else atomicLink(snapshot.workers, paths.workers);
  const env = path.join(paths.config, 'acquisition-release.env');
  restoreFile(env, snapshot.workerEnvironment, 0o640); if (snapshot.workerEnvironment !== null) own(env);
}
export function installComponent(component, directory, environmentHash, paths, own = () => {}) {
  ensureDeploymentState(paths);
  const manifest = readManifest(directory);
  if (manifest.workerGroups?.protocol !== COMPONENT_PROTOCOL || !manifest.workerGroups.components[component]) throw new Error('Candidate lacks component proof.');
  const prior = linkTarget(path.join(paths.pins, component));
  if (prior && prior !== directory) atomicLink(prior, path.join(paths.pins, `${component}.rollback`));
  atomicLink(directory, path.join(paths.pins, component));
  const env = path.join(paths.config, 'worker-releases', `${component}.env`);
  atomicWrite(env, componentEnvironment(component, manifest.release), 0o640); own(env);
  for (const name of WORKER_COMPONENTS[component].units) {
    for (const suffix of ['service', 'timer']) {
      const filename = `${name}.${suffix}`;
      const source = readOptional(path.join(directory, 'scripts/deployment/m70', filename));
      if (source !== null) atomicWrite(path.join(paths.units, filename), suffix === 'service' ? renderWorkerUnit(source, component, paths) : source, 0o644);
    }
  }
  const state = JSON.parse(readOptional(componentStatePath(paths)) || '{"version":1,"groups":{}}');
  state.groups[component] = { release: manifest.release, environmentHash };
  atomicWrite(componentStatePath(paths), JSON.stringify(state));
  if (component === 'pipeline') {
    atomicLink(directory, paths.workers);
    const globalEnvironment = path.join(paths.config, 'acquisition-release.env');
    atomicWrite(globalEnvironment, `ATS_WORKER_RELEASE_ID=${manifest.release}\n`, 0o640); own(globalEnvironment);
  }
}

export function planComponentActivation(directory, environmentHash, paths = deploymentPaths()) {
  const candidate = readManifest(directory);
  const full = (reason) => ({ version: COMPONENT_PROTOCOL, mode: 'coordinated', release: candidate.release, reason,
    changed: [], unchanged: [], environmentHash });
  try {
    const verifiedGroups = (groups) => groups?.protocol === COMPONENT_PROTOCOL
      && /^[a-f0-9]{64}$/.test(groups.coordinationHash)
      && groups.components && Object.keys(groups.components).sort().join() === Object.keys(WORKER_COMPONENTS).sort().join()
      && Object.values(groups.components).every((value) => value && /^[a-f0-9]{64}$/.test(value.inputsHash));
    if (!verifiedGroups(candidate.workerGroups)) return full('Candidate has no component compatibility proof.');
    const state = JSON.parse(fs.readFileSync(componentStatePath(paths), 'utf8'));
    if (state.version !== COMPONENT_PROTOCOL || Object.keys(state.groups).sort().join() !== Object.keys(WORKER_COMPONENTS).sort().join()) return full('Worker pin protocol is not installed.');
    const changed = [], unchanged = [];
    for (const [name, component] of Object.entries(WORKER_COMPONENTS)) {
      const pin = state.groups[name];
      if (!pin || !/^[a-f0-9]{40}$/.test(pin.release) || pin.environmentHash !== environmentHash) return full('Worker settings changed or their baseline is missing.');
      const prior = readManifest(path.join(paths.pins, name));
      if (fs.realpathSync(path.join(paths.pins, name)) !== fs.realpathSync(path.join(paths.releases, pin.release))) return full('A worker pin points outside its recorded release.');
      if (prior.release !== pin.release || !verifiedGroups(prior.workerGroups)
        || prior.workerGroups?.coordinationHash !== candidate.workerGroups.coordinationHash) return full('Coordination, schema, dependency or unclassified inputs changed.');
      if (readOptional(path.join(paths.config, 'worker-releases', `${name}.env`)) !== componentEnvironment(name, pin.release)) return full('Installed worker configuration differs from its pin.');
      for (const unit of component.units) {
        const dropins = path.join(paths.units, `${unit}.service.d`);
        if (fs.existsSync(dropins) && fs.readdirSync(dropins).some((name) => name !== '50-automatic-maintenance.conf')) return full('An unreviewed service override requires coordinated activation.');
        for (const suffix of ['service', 'timer']) {
          const filename = `${unit}.${suffix}`;
          const source = readOptional(path.join(paths.releases, pin.release, 'scripts/deployment/m70', filename));
          const installed = readOptional(path.join(paths.units, filename));
          const candidateSource = readOptional(path.join(directory, 'scripts/deployment/m70', filename));
          if ((source === null) !== (candidateSource === null)) return full('Worker unit membership changed.');
          if (source !== null && installed !== (suffix === 'service' ? renderWorkerUnit(source, name, paths) : source)) return full('Installed worker units have drifted.');
        }
      }
      if (prior.workerGroups.components[name]?.inputsHash !== candidate.workerGroups.components[name]?.inputsHash) {
        if (component.strategy === 'coordinated') return full('Long-running discovery or storage code requires coordinated activation.');
        changed.push(name);
      } else unchanged.push(name);
    }
    return { version: COMPONENT_PROTOCOL, mode: changed.length ? 'rolling' : 'web', release: candidate.release, changed, unchanged, environmentHash };
  } catch { return full('Component state is absent, unreadable or unverified.'); }
}

export function ownWorkerFile(filename) { execFileSync('chown', ['root:career-dashboard', filename]); }
