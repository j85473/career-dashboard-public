'use client';

import { useEffect, useState } from 'react';
import { DASHBOARD_REFRESH_EVENT, dashboardRefreshBlocked } from './dashboardAutoRefresh';

/** Align updates with displayed minutes and refresh immediately after returning to the page. */
export function useInterviewClock(enabled = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      // Moving a card between sections remounts it. Keep its editor in place
      // until the draft/save is finished, then catch up on the next refresh.
      if (!dashboardRefreshBlocked()) setNow(Date.now());
      clearTimeout(timer);
      timer = setTimeout(tick, 60_000 - Date.now() % 60_000);
    };
    timer = setTimeout(tick, 0);
    window.addEventListener('focus', tick);
    window.addEventListener(DASHBOARD_REFRESH_EVENT, tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', tick);
      window.removeEventListener(DASHBOARD_REFRESH_EVENT, tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled]);
  return now;
}
