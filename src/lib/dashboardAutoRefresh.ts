export const DASHBOARD_REFRESH_EVENT = 'dashboardDataRefresh';
export const DASHBOARD_REFRESH_MS = 20_000;

let revision = 0;
let pendingWrites = 0;
const baselines = new WeakMap<Element, string>();
const dirty = new Set<HTMLElement>();

const valueOf = (element: HTMLElement) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
  ? element.value : element.textContent || '';

const editable = (element: Element | null) => element instanceof HTMLElement
  && (element.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])')
    || element.isContentEditable);

export function dashboardRefreshBlocked(): boolean {
  // React can clear a saved/imported field without firing another input event.
  // Removed editors and values returned to their original state are clean.
  for (const element of dirty) {
    if (!element.isConnected || valueOf(element) === (baselines.get(element) ?? '')) {
      delete element.dataset.refreshDirty;
      dirty.delete(element);
    }
  }
  const active = document.activeElement;
  return document.hidden || pendingWrites > 0 || (editable(active) && !active?.closest('[data-refresh-transient]'))
    || Boolean(document.querySelector('[data-refresh-blocked="true"], [data-refresh-dirty="true"]'));
}

/** Reject a background response if editing or a save began while it was away. */
export function dashboardRefreshGuard(): () => boolean {
  const startedAtRevision = revision;
  return () => startedAtRevision === revision && !dashboardRefreshBlocked();
}

/** One shared clock for visible data and deployment checks, independent of pipeline activity. */
export function startDashboardAutoRefresh(options: {
  version: string | null;
  reload: () => void;
}): () => void {
  let stopped = false;
  let latestVersion = options.version;
  let checking: AbortController | undefined;
  let lastActivity = Date.now();
  let lastTick = 0;
  let reloading = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const remember = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLElement && editable(target) && !baselines.has(target)) baselines.set(target, valueOf(target));
  };
  const tryReload = () => {
    clearTimeout(reloadTimer);
    if (stopped || reloading || !options.version || latestVersion === options.version || !latestVersion) return;
    if (dashboardRefreshBlocked() || editable(document.activeElement)
      || document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
    const idleFor = Date.now() - lastActivity;
    if (idleFor < 2_000) {
      reloadTimer = setTimeout(tryReload, 2_000 - idleFor);
      return;
    }
    reloading = true;
    options.reload();
  };
  const activity = () => { lastActivity = Date.now(); };
  const changed = (event: Event) => {
    revision++;
    activity();
    const target = event.target;
    if (!(target instanceof HTMLElement) || !editable(target) || target.closest('[data-refresh-transient]')) return;
    const baseline = baselines.get(target) ?? '';
    if (valueOf(target) !== baseline) {
      target.dataset.refreshDirty = 'true';
      dirty.add(target);
    } else {
      delete target.dataset.refreshDirty;
      dirty.delete(target);
    }
  };

  // Protect all saves/imports/uploads, including controls outside job cards.
  // The wrapper forwards every argument and leaves response handling untouched.
  const originalFetch = window.fetch;
  const guardedFetch: typeof window.fetch = async (input, init) => {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (writes) { pendingWrites++; revision++; }
    try { return await originalFetch.call(window, input, init); }
    finally {
      if (writes) {
        pendingWrites--;
        // Let the caller process the response and close its editor first.
        lastActivity = Date.now();
        clearTimeout(reloadTimer);
        if (!stopped) reloadTimer = setTimeout(tryReload, 2_000);
      }
    }
  };
  window.fetch = guardedFetch;

  const tick = () => {
    if (stopped || document.hidden) return;
    tryReload();
    if (reloading) return;
    // Safari can deliver focus, pageshow and visibilitychange together.
    if (Date.now() - lastTick < 500) return;
    lastTick = Date.now();
    if (!dashboardRefreshBlocked()) window.dispatchEvent(new Event(DASHBOARD_REFRESH_EVENT));
    if (!options.version || checking) return;
    const controller = new AbortController();
    checking = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    void (async () => {
      try {
        const response = await fetch('/api/version', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        if (stopped || controller.signal.aborted || typeof data.version !== 'string' || !data.version) return;
        latestVersion = data.version;
        tryReload();
      } catch { /* A restart or offline connection is retried on the next tick. */ }
      finally { clearTimeout(timeout); if (checking === controller) checking = undefined; }
    })();
  };
  const timer = setInterval(tick, DASHBOARD_REFRESH_MS);
  window.addEventListener('focus', tick);
  window.addEventListener('pageshow', tick);
  document.addEventListener('visibilitychange', tick);
  document.addEventListener('focusin', remember, true);
  document.addEventListener('beforeinput', remember, true);
  document.addEventListener('input', changed, true);
  document.addEventListener('change', changed, true);
  document.addEventListener('pointerdown', activity, true);
  document.addEventListener('keydown', activity, true);

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(reloadTimer);
    checking?.abort();
    if (window.fetch === guardedFetch) window.fetch = originalFetch;
    window.removeEventListener('focus', tick);
    window.removeEventListener('pageshow', tick);
    document.removeEventListener('visibilitychange', tick);
    document.removeEventListener('focusin', remember, true);
    document.removeEventListener('beforeinput', remember, true);
    document.removeEventListener('input', changed, true);
    document.removeEventListener('change', changed, true);
    document.removeEventListener('pointerdown', activity, true);
    document.removeEventListener('keydown', activity, true);
    dirty.forEach(element => { delete element.dataset.refreshDirty; });
    dirty.clear();
  };
}
