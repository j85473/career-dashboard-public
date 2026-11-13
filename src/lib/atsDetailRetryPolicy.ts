import type { AtsRetryReason } from './atsRetryReason';

const EVIDENCE_RETRIES = new Set(['employer_unverified', 'location_unverified', 'posting_mismatch']);
const EVIDENCE_RETRY_MINUTES = [15, 60, 240, 720, 1440] as const;

/** Retained evidence failures get another attempt, with progressively less
 * capacity. Provider deadlines and longer existing holds remain authoritative. */
export function retainedAtsDetailRetryAt(input: {
  now: Date;
  attemptCount: number;
  reason: AtsRetryReason;
  suggestedRetryAt?: Date;
}): Date {
  const ordinary = input.suggestedRetryAt?.getTime() ?? input.now.getTime() + 15 * 60_000;
  if (input.reason.scope !== 'posting' || !EVIDENCE_RETRIES.has(input.reason.code)) return new Date(ordinary);
  const attempt = Number.isFinite(input.attemptCount) ? Math.max(1, Math.floor(input.attemptCount)) : 1;
  const minutes = EVIDENCE_RETRY_MINUTES[Math.min(EVIDENCE_RETRY_MINUTES.length - 1, attempt - 1)];
  return new Date(Math.max(ordinary, input.now.getTime() + minutes * 60_000));
}
