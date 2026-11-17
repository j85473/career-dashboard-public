import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DiscoveryRuntimeStatus = {
  token: string; pid: number; kind: 'scan' | 'recovery'; state: 'running' | 'stopping' | 'complete' | 'stopped' | 'failed';
  startedAt: string; heartbeatAt: string; message: string;
  logs?: string[];
};
type ManualRequest = { token: string; requestedAt: string };
export const discoveryRuntimeDirectory = () => path.resolve(process.env.ATS_DISCOVERY_RUNTIME_DIR || 'data/runtime');
const filename = (name: string, directory = discoveryRuntimeDirectory()) => path.join(directory, name);
async function readJson<T>(name: string, directory?: string): Promise<T | null> {
  try { return JSON.parse(await readFile(filename(name, directory), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
async function saveJson(name: string, value: unknown, directory?: string) {
  const target = filename(name, directory), temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, target);
}

async function withRequestLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = filename('discovery-manual-request.lock', directory);
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await open(lock, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // This lock covers only a few local atomic-file operations, never a
      // network or database call. A crashed writer cannot strand the control.
      const saved = await stat(lock).catch(() => null);
      if (!saved) continue;
      if (Date.now() - saved.mtimeMs <= 30_000) throw Error('A discovery start request is already being recorded');
      await unlink(lock).catch(() => undefined);
    }
  }
  if (!handle) throw Error('Discovery control is busy');
  try { return await work(); }
  finally { await handle.close(); await unlink(lock).catch(() => undefined); }
}

export function discoveryRuntimeAlive(status: DiscoveryRuntimeStatus | null, now = Date.now(), alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
}): boolean {
  return !!status && ['running', 'stopping'].includes(status.state) && Number.isSafeInteger(status.pid) && status.pid > 1
    && now - Date.parse(status.heartbeatAt) < 120_000 && alive(status.pid);
}

export async function readDiscoveryRuntime(directory?: string) {
  const [status, request, stop, consumed] = await Promise.all([
    readJson<DiscoveryRuntimeStatus>('discovery-status.json', directory), readJson<ManualRequest>('discovery-manual-request.json', directory),
    readJson<{ token: string }>('discovery-stop.json', directory),
    readJson<{ token: string }>('discovery-manual-consumed.json', directory),
  ]);
  const running = discoveryRuntimeAlive(status);
  const unmatchedRequest = !running && !!request && request.token !== status?.token && request.token !== consumed?.token;
  const requestCancelled = unmatchedRequest && stop?.token === request?.token;
  const starting = unmatchedRequest && !requestCancelled && Date.now() - Date.parse(request!.requestedAt) < 30_000;
  const startupExpired = unmatchedRequest && !requestCancelled && !starting;
  return { status, isRunning: running, starting, startupExpired, requestCancelled,
    token: running ? status!.token : starting ? request!.token : null };
}

/** Fixed file bridge: the managed service owns environment, release and flock. */
export async function requestDiscoveryStart(directory = discoveryRuntimeDirectory()) {
  return withRequestLock(directory, async () => {
    const state = await readDiscoveryRuntime(directory);
    if (state.isRunning || state.starting) throw Error('Discovery is already running or starting');
    const request = { token: randomUUID(), requestedAt: new Date().toISOString() };
    await saveJson('discovery-manual-request.json', request, directory);
    return request;
  });
}

export async function requestDiscoveryStop(expectedToken: string, directory = discoveryRuntimeDirectory()) {
  const state = await readDiscoveryRuntime(directory);
  if (!expectedToken || state.token !== expectedToken) throw Error('Discovery owner changed; refresh its status before stopping');
  if (state.status?.kind === 'recovery' && state.isRunning) throw Error('A bounded validation recovery pass is running; it will finish independently');
  await saveJson('discovery-stop.json', { token: expectedToken }, directory);
  return state.isRunning ? 'stopping' : 'stopped';
}

/** All scheduled/manual invocations call this only after acquiring discovery.lock. */
export async function startDiscoveryRuntime(kind: 'scan' | 'recovery', manual = false, directory = discoveryRuntimeDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const status = await withRequestLock(directory, async () => {
    const request = manual ? await readJson<ManualRequest>('discovery-manual-request.json', directory) : null;
    const prior = await readJson<DiscoveryRuntimeStatus>('discovery-status.json', directory);
    const consumed = await readJson<{ token: string }>('discovery-manual-consumed.json', directory);
    if (manual && (!request || request.token === prior?.token || request.token === consumed?.token || Date.now() - Date.parse(request.requestedAt) > 30_000)) {
      throw Error('Manual discovery request expired or was already consumed');
    }
    const claimed: DiscoveryRuntimeStatus = { token: request?.token || randomUUID(), pid: process.pid, kind,
      state: 'running', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), message: 'Discovery is running' };
    // The owner token is the durable consumption receipt. Never rewrite the
    // watched request file from the worker and retrigger the systemd path.
    await saveJson('discovery-status.json', claimed, directory);
    if (manual) await saveJson('discovery-manual-consumed.json', { token: claimed.token }, directory);
    return claimed;
  });
  const tick = async () => {
    const stop = await readJson<{ token?: string }>('discovery-stop.json', directory);
    if (stop?.token === status.token) { controller.abort(Error('Discovery stopped by operator')); status.state = 'stopping'; }
    status.heartbeatAt = new Date().toISOString();
    await saveJson('discovery-status.json', status, directory);
  };
  await tick();
  let pending = Promise.resolve();
  const timer = setInterval(() => { pending = pending.then(tick).catch(() => controller.abort(Error('Discovery heartbeat could not be saved'))); }, 1_000);
  timer.unref();
  const stopped = () => controller.abort(Error('Discovery worker stopping'));
  process.once('SIGINT', stopped); process.once('SIGTERM', stopped);
  return {
    signal: controller.signal,
    report: (message: string) => {
      status.message = message.slice(-2000);
      status.logs = [...(status.logs || []), status.message].slice(-100);
    },
    finish: async (error?: unknown) => {
      clearInterval(timer); await pending;
      process.removeListener('SIGINT', stopped); process.removeListener('SIGTERM', stopped);
      status.state = controller.signal.aborted ? 'stopped' : error ? 'failed' : 'complete';
      status.heartbeatAt = new Date().toISOString();
      status.message = status.state === 'stopped' ? 'Discovery stopped; saved progress is retained'
        : error ? 'Discovery failed safely; saved progress is retained' : 'Discovery process completed successfully';
      await saveJson('discovery-status.json', status, directory);
    },
  };
}
