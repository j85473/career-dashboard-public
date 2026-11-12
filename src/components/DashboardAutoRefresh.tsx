'use client';

import { useEffect } from 'react';
import { startDashboardAutoRefresh } from '@/lib/dashboardAutoRefresh';

export function DashboardAutoRefresh() {
  useEffect(() => startDashboardAutoRefresh({
    version: process.env.NODE_ENV === 'production' ? process.env.NEXT_PUBLIC_DASHBOARD_BUILD_VERSION || null : null,
    reload: () => window.location.reload(),
  }), []);
  return null;
}
