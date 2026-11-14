import fs from 'node:fs';
import path from 'node:path';

export type WorkerHandoff = { version: 1; token: string; component: string; deadline: number;
  softDrain: boolean; resumeMode: 'full' | null };

export function workerDrainDirectory() {
  return process.env.WORKER_DRAIN_DIRECTORY || path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'runtime', 'worker-drain');
}

export function readWorkerHandoff(component: string): WorkerHandoff | null | 'unreadable' {
  if (!/^[a-z][a-z-]*$/.test(component)) return 'unreadable';
  try {
    const value = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(workerDrainDirectory(), `${component}.json`), 'utf8'));
    if (value.version !== 1 || value.component !== component || typeof value.token !== 'string'
      || !/^[a-f0-9-]{36}$/.test(value.token) || !Number.isFinite(value.deadline)
      || typeof value.softDrain !== 'boolean' || ![null, 'full'].includes(value.resumeMode)) return 'unreadable';
    return value;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'; }
}

export function workerDeploymentBlocked(component = process.env.CAREER_WORKER_COMPONENT): boolean {
  return Boolean(component && readWorkerHandoff(component));
}

/** Soft drain holds lanes between tasks. It never aborts a current task. */
export function workerDrainRequested(component = process.env.CAREER_WORKER_COMPONENT): boolean {
  if (!component) return false;
  const handoff = readWorkerHandoff(component);
  return handoff === 'unreadable' || Boolean(handoff?.softDrain);
}

/** An explicit operator pause still takes precedence over this technical gap. */
export function acquisitionCanContinueDuringHandoff(now = Date.now()): boolean {
  if (process.env.CAREER_WORKER_COMPONENT !== 'acquisition') return false;
  const handoff = readWorkerHandoff('pipeline');
  return handoff !== null && handoff !== 'unreadable' && handoff.resumeMode === 'full' && handoff.deadline > now;
}

const lanes = new Map<string, boolean>();
export function initializeWorkerDrainLanes(names: string[]) {
  lanes.clear();
  for (const name of names) lanes.set(name, false);
}
export function setWorkerLaneDrained(name: string, drained: boolean) { lanes.set(name, drained); }
export function workerLanesDrained(): boolean {
  return workerDrainRequested() && lanes.size > 0 && [...lanes.values()].every(Boolean);
}
export function clearWorkerDrainLanes() { lanes.clear(); }

/** A local readiness receipt only; job checkpoints and leases stay in PostgreSQL. */
export function writeWorkerDeploymentStatus(drained: boolean) {
  const component = process.env.CAREER_WORKER_COMPONENT;
  if (!component || !/^[a-z][a-z-]*$/.test(component)) return;
  const directory = workerDrainDirectory();
  fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true });
  const filename = path.join(directory, `${component}.status.json`);
  const temporary = `${filename}.${process.pid}.tmp`;
  const handoff = readWorkerHandoff(component);
  fs.writeFileSync(/* turbopackIgnore: true */ temporary, JSON.stringify({ version: 1, component, pid: process.pid,
    release: process.env.ATS_WORKER_RELEASE_ID, drained, at: Date.now(),
    handoffToken: handoff !== null && handoff !== 'unreadable' ? handoff.token : null }), { mode: 0o600 });
  fs.renameSync(/* turbopackIgnore: true */ temporary, filename);
}
