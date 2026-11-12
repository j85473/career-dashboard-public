'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DASHBOARD_REFRESH_EVENT, dashboardRefreshBlocked } from './dashboardAutoRefresh';

export function useDashboardRefresh(refresh: () => void) {
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; });
  useEffect(() => {
    const run = () => { if (!dashboardRefreshBlocked()) latest.current(); };
    window.addEventListener(DASHBOARD_REFRESH_EVENT, run);
    return () => window.removeEventListener(DASHBOARD_REFRESH_EVENT, run);
  }, []);
}

/** Preserve the visible card even when new results are inserted above it. */
export function useQuietRefreshCommit() {
  const anchor = useRef<{ container: HTMLElement; top: number; windowScroll: boolean; items: Array<{ id: string; offset: number }> } | null>(null);
  const [committed, setCommitted] = useState(0);
  const commit = useCallback((update: () => void) => {
    const container = document.getElementById('main');
    if (container) {
      const top = Math.max(0, container.getBoundingClientRect().top);
      const windowScroll = window.scrollY > 0 && container.scrollTop === 0;
      anchor.current = { container, top: windowScroll ? window.scrollY : container.scrollTop, windowScroll,
        items: Array.from(container.querySelectorAll<HTMLElement>('[data-job-id]'))
          .filter(element => element.getBoundingClientRect().bottom > top)
          .slice(0, 8).map(element => ({ id: element.dataset.jobId!, offset: element.getBoundingClientRect().top })) };
    }
    update();
    setCommitted(value => value + 1);
  }, []);
  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = null;
    if (!saved || saved.top < 5) return;
    const cards = Array.from(saved.container.querySelectorAll<HTMLElement>('[data-job-id]'));
    for (const item of saved.items) {
      const card = cards.find(element => element.dataset.jobId === item.id);
      if (card) {
        const delta = card.getBoundingClientRect().top - item.offset;
        if (saved.windowScroll) window.scrollBy(0, delta);
        else saved.container.scrollTop += delta;
        break;
      }
    }
  }, [committed]);
  return commit;
}
