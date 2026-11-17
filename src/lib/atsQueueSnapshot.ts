/** JSON-safe operator telemetry. Counts use distinct stages, never a combined
 * total of boards, candidates, segments and jobs. */
export type AtsQueueHold = {
  stage: 'Validation' | 'Validation due' | 'Size review' | 'First collection' | 'Acquisition due' | 'Acquisition' | 'Persistence' | 'Posting detail' | 'Provider' | 'Common Crawl';
  provider: string;
  reason: string;
  count: number;
  unit: 'candidates' | 'boards' | 'batches' | 'segments' | 'postings' | 'providers' | 'checkpoints';
  items: number;
  retryAt: string | null;
  lastRetryAt: string | null;
  example: string | null;
};
export type AtsQueueSnapshot = {
  retained?: import('./atsRetainedInventory').AtsRetainedInventory;
  capacity?: Awaited<ReturnType<typeof import('./atsCapacityTelemetry').readAtsCapacityTelemetry>>;
  observedAt: string;
  mode: string;
  admissionNote: string;
  validationDue: number;
  validationHeld: number;
  sizeReview: number;
  ready: number;
  awaitingHandoff: number;
  collecting: number;
  persistenceDue: number;
  persistenceHeld: number;
  persistenceEvidenceHeld?: number;
  browserDetails?: { pending: number; retryDateReached: number; scheduled: number; inactiveBoards: number };
  holds: AtsQueueHold[];
};

export function atsRetryLabel(retryAt: string | null, observedAt: string, review = false): string {
  if (review) return 'Review required · no automatic retry';
  if (!retryAt) return 'No retry time recorded';
  const time = new Date(retryAt);
  if (!Number.isFinite(time.valueOf())) return 'Retry time unavailable';
  if (time.valueOf() <= new Date(observedAt).valueOf()) return 'Eligible now';
  return `${time.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} Central`;
}
