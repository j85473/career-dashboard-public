import { prisma } from '@/lib/prisma';
import { scoreJobs } from '@/lib/jobScoring';
import { recoverStaleLocalScoringLeases } from '@/lib/localScoringLeaseRecovery';
import {
  abortActivePipeline, persistPipelineStateMirror, pipelineOperatorStopRequested,
  pipelineStopRequested, registerActivePipelineAbortController, startPipelineLockHeartbeat,
  tryAcquirePipelineLock, updatePipelineState, waitForPipelineDelay,
} from '@/lib/pipelineState';

let activeManualRun: Promise<void> | null = null;
let activeMode: 'local' | 'extraction' | null = null;
export function manualPipelineMode() { return activeManualRun ? activeMode : null; }

async function launchManualRun(release: () => Promise<void>, run: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const clear = registerActivePipelineAbortController(controller);
  if (!clear) {
    await release();
    throw new Error('This process already owns a pipeline run.');
  }
  const stopHeartbeat = startPipelineLockHeartbeat();
  const observer = setInterval(() => {
    void pipelineOperatorStopRequested().then((stopped) => {
      if (stopped) controller.abort(new Error('Shared pipeline stop requested.'));
    }).catch(console.error);
  }, 1_000);
  observer.unref();
  activeManualRun = run(controller.signal).finally(async () => {
    clearInterval(observer);
    stopHeartbeat();
    clear();
    await release();
  }).catch(console.error).finally(() => { activeManualRun = null; });
}

export async function stopManualPipelineProcess() {
  abortActivePipeline('Pipeline service is shutting down.');
  await activeManualRun;
}

export async function startLocalPipeline() {
  try {
    const releaseLock = await tryAcquirePipelineLock();
    if (!releaseLock) {
      return Response.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    try {
      const starting = updatePipelineState({ isRunning: true, currentStep: 'Local Scoring', stepProgress: 'Initializing local scoring pipeline...' });
      await persistPipelineStateMirror(starting, null);
    } catch (error) {
      await releaseLock();
      throw error;
    }

    // Run scoring in background
    activeMode = 'local';
    await launchManualRun(releaseLock, async (signal) => {
      try {
        updatePipelineState({ stepProgress: 'Running local triage and heuristic scoring...' });
        const recoveredLocalScoringLeases = await recoverStaleLocalScoringLeases();
        if (recoveredLocalScoringLeases > 0) {
          console.warn(`Recovered ${recoveredLocalScoringLeases} stale local-scoring lease(s).`);
        }
        const queuedCount = await prisma.job.count({ where: { scoringStatus: 'queued', jdBatchId: null, status: { in: ['pending_af', 'inbox'] } } });
        let totalScored = 0;
        for (let localPass = 0; localPass < 20; localPass++) {
          if (signal.aborted || await pipelineStopRequested()) break;
          const processed = await scoreJobs((msg) => {
            if (!msg.startsWith('No new jobs') && !msg.startsWith('No resumes')) totalScored++;
            updatePipelineState({ stepProgress: `[Processed: ${totalScored}/${queuedCount}] ${msg}` });
          }, signal);
          if (processed === 0) break;
        }
        updatePipelineState({
          isRunning: false,
          currentStep: 'Idle',
          stepProgress: `Local scoring complete. Processed ${totalScored} jobs.`,
        });
      } catch (error) {
        console.error('Local Scoring error:', error);
        updatePipelineState({
          isRunning: false,
          currentStep: 'Error',
          stepProgress: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });

    return Response.json({ message: 'Local Scoring started in background' });
  } catch (error: unknown) {
    return Response.json(
      { error: 'Failed to start local scoring', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function startExtractionPipeline() {
  try {
    const releaseLock = await tryAcquirePipelineLock();
    if (!releaseLock) {
      return Response.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    try {
      const starting = updatePipelineState({ isRunning: true, currentStep: 'JD Extraction', stepProgress: 'Initializing extraction pipeline...' });
      await persistPipelineStateMirror(starting, null);
    } catch (error) {
      await releaseLock();
      throw error;
    }

    // Run in background
    activeMode = 'extraction';
    await launchManualRun(releaseLock, async (signal) => {
      try {
        let loopCount = 0;
        let initialNeedsJdCount = -1;
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        while (!signal.aborted && !await pipelineStopRequested()) {
          loopCount++;
          const needsJdCount = await prisma.job.count({
            where: { scoringStatus: 'needs_jd', jdBatchId: null, status: { in: ['pending_af', 'inbox'] }, scoreAttempts: { lt: 3 } }
          });
          const processingJdCount = await prisma.job.count({
            where: { scoringStatus: 'needs_jd', jdBatchId: { not: null }, status: { in: ['pending_af', 'inbox'] } }
          });

          const currentTotal = needsJdCount + processingJdCount;
          if (initialNeedsJdCount === -1 || currentTotal > initialNeedsJdCount) initialNeedsJdCount = currentTotal;
          const processed = initialNeedsJdCount - currentTotal;

          if (needsJdCount === 0 && processingJdCount === 0) {
            updatePipelineState({ stepProgress: `JD extraction complete. Processed ${processed} jobs.` });
            break;
          }

          if (needsJdCount > 0 && processingJdCount === 0) {
            updatePipelineState({ stepProgress: `[Processed: ${processed}] Pass ${loopCount}: Extracting JDs for ${needsJdCount} jobs...` });
            const req = new Request(`${appUrl}/api/jobs/batch-jd-submit`, { method: 'POST', signal });
            try {
              // Local fetch doesn't easily work without an absolute URL or proper setup in AppRouter,
              // but since we're in the same process, it's actually safer to just do a fetch to internal route
              // OR we can just import the route handler. Since POST from /batch-jd-submit expects a Request...
              const { POST: batchSubmitPost } = await import('@/app/api/jobs/batch-jd-submit/route');
              const res = await batchSubmitPost(req);
              if (!res.ok) {
                 console.error('Extraction batch returned non-ok status');
                 break;
              }
            } catch (err) {
              console.error('JD extraction error:', err);
              break; // Stop loop on hard error
            }
          } else if (processingJdCount > 0) {
            updatePipelineState({ stepProgress: `Pass ${loopCount}: Waiting for JD recovery to finish ${processingJdCount} jobs...` });
            await waitForPipelineDelay(10_000, signal);
          }
        }

        updatePipelineState({
          isRunning: false,
          currentStep: 'Idle',
          stepProgress: `JD extraction loop finished.`,
        });
      } catch (error) {
        console.error('Extraction pipeline error:', error);
        updatePipelineState({
          isRunning: false,
          currentStep: 'Error',
          stepProgress: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });

    return Response.json({ message: 'JD Extraction started in background' });
  } catch (error: unknown) {
    return Response.json(
      { error: 'Failed to start extraction pipeline', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
