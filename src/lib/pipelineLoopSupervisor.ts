type PipelineLoopOptions = {
  signal: AbortSignal;
  /** Operator/deployment stop only; a temporary storage hold is not a stop. */
  shouldStop: () => Promise<boolean>;
  /** Notify the owning run so sibling loops receive the same stop signal. */
  onStopRequested?: () => void;
  canRun: () => boolean;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onError: (error: unknown, consecutiveFailures: number) => void;
  onStoragePauseChange?: (paused: boolean) => void;
};

/** Keep a lane owned and recoverable while a temporary storage hold clears. */
export async function supervisePipelineLoop(
  runLoop: () => Promise<void>,
  options: PipelineLoopOptions,
): Promise<void> {
  const shouldStop = async () => {
    const stopped = await options.shouldStop();
    if (stopped) options.onStopRequested?.();
    return stopped;
  };
  let consecutiveFailures = 0;
  let storagePaused = false;
  while (!options.signal.aborted) {
    if (await shouldStop() || options.signal.aborted) return;
    if (!options.canRun()) {
      if (!storagePaused) {
        storagePaused = true;
        options.onStoragePauseChange?.(true);
      }
      await options.wait(5_000, options.signal);
      continue;
    }
    if (storagePaused) {
      storagePaused = false;
      options.onStoragePauseChange?.(false);
    }
    try {
      await runLoop();
      if (options.signal.aborted || await shouldStop()) return;
      // Inner loops yield at their existing storage/admission checks. The hold
      // may already have cleared by the time they unwind, so a clean return
      // must not permanently retire this lane. Join it before starting again.
      consecutiveFailures = 0;
      await options.wait(1_000, options.signal);
    } catch (error) {
      if (options.signal.aborted || await shouldStop()) return;
      consecutiveFailures++;
      options.onError(error, consecutiveFailures);
      const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.min(consecutiveFailures - 1, 6));
      await options.wait(backoffMs, options.signal);
    }
  }
}
