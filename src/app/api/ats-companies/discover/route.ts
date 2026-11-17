import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { discoveryRecoveryAllowed, discoveryRecoverySnapshot } from '@/lib/atsDiscoveryValidationRecovery';
import { readDiscoveryRuntime, requestDiscoveryStart, requestDiscoveryStop } from '@/lib/atsDiscoveryRuntime';
import { storageAllows } from '@/lib/storagePressure';

export const dynamic = 'force-dynamic';
let recoveryCache: { until: number; value: Awaited<ReturnType<typeof discoveryRecoverySnapshot>> } | null = null;
let recoveryRefresh: Promise<void> | null = null;

export async function GET() {
  try {
    const runtime = await readDiscoveryRuntime();
    if (!recoveryCache || recoveryCache.until < Date.now()) {
      recoveryRefresh ||= discoveryRecoverySnapshot(prisma).then(value => { recoveryCache = { until: Date.now() + 60_000, value }; })
        .finally(() => { recoveryRefresh = null; });
      await recoveryRefresh;
    }
    const state = runtime.starting ? 'starting' : runtime.startupExpired ? 'failed' : runtime.requestCancelled ? 'stopped'
      : runtime.isRunning ? runtime.status!.state : runtime.status && ['running', 'stopping'].includes(runtime.status.state) ? 'interrupted'
        : runtime.status?.state || 'idle';
    const message = runtime.starting ? 'Waiting for the managed discovery worker to start'
      : runtime.startupExpired ? 'Managed discovery did not start. Its lane may be busy, disabled, or paused; saved progress is retained.'
        : runtime.requestCancelled ? 'Discovery start was cancelled; saved progress is retained'
          : state === 'interrupted' ? 'Discovery worker is no longer running; its saved progress can resume'
            : runtime.status?.message || 'Discovery is idle; saved progress is retained';
    return NextResponse.json({ isRunning: runtime.isRunning || runtime.starting,
      token: runtime.token, state,
      kind: runtime.status?.kind, logs: [...(runtime.status?.logs || []), message].slice(-100), recovery: recoveryCache?.value });
  } catch { return NextResponse.json({ error: 'Discovery status could not be read' }, { status: 503 }); }
}

export async function POST() {
  if (!storageAllows('collection')) return NextResponse.json({ error: 'Discovery is paused to preserve database storage' }, { status: 409 });
  if (!await discoveryRecoveryAllowed(prisma)) return NextResponse.json({ error: 'Discovery is paused by the pipeline operator control' }, { status: 409 });
  if (process.platform !== 'linux') return NextResponse.json({ error: 'Manual discovery requires the managed production worker' }, { status: 503 });
  try {
    const request = await requestDiscoveryStart();
    return NextResponse.json({ status: 'starting', token: request.token, isRunning: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Discovery could not be started' }, { status: 409 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { token?: unknown };
    if (typeof body.token !== 'string') return NextResponse.json({ error: 'The current discovery owner is required' }, { status: 400 });
    const status = await requestDiscoveryStop(body.token);
    return NextResponse.json({ status, isRunning: status === 'stopping' });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Discovery could not be stopped' }, { status: 409 });
  }
}
