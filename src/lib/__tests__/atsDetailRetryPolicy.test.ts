import assert from 'node:assert/strict';
import test from 'node:test';
import { retainedAtsDetailRetryAt } from '../atsDetailRetryPolicy';
import type { AtsRetryCode } from '../atsRetryReason';

const now = new Date('2026-11-13T19:00:00Z');
test('unverified employer, location and posting details remain pending on a bounded retry schedule', () => {
  for (const code of ['employer_unverified', 'location_unverified', 'posting_mismatch'] as const) {
    for (const [attemptCount, minutes] of [[1, 15], [2, 60], [3, 240], [4, 720], [5, 1440], [199, 1440]]) {
      assert.equal(retainedAtsDetailRetryAt({ now, attemptCount, reason: { code, scope: 'posting' } }).getTime(),
        now.getTime() + minutes * 60_000);
    }
  }
});

test('longer existing retry deadlines and provider Retry-After are preserved', () => {
  const suggestedRetryAt = new Date(now.getTime() + 48 * 3600_000);
  assert.equal(retainedAtsDetailRetryAt({ now, attemptCount: 200,
    reason: { code: 'employer_unverified', scope: 'posting' }, suggestedRetryAt }).getTime(), suggestedRetryAt.getTime());
  for (const code of ['provider_rate_limit', 'provider_unavailable', 'network_failure', 'operation_interrupted', 'internal_error'] as AtsRetryCode[]) {
    const deadline = new Date(now.getTime() + 5 * 60_000);
    assert.equal(retainedAtsDetailRetryAt({ now, attemptCount: 200,
      reason: { code, scope: code.startsWith('provider') ? 'provider' : 'posting' }, suggestedRetryAt: deadline }).getTime(), deadline.getTime());
  }
  assert.equal(retainedAtsDetailRetryAt({ now, attemptCount: 200,
    reason: { code: 'posting_mismatch', scope: 'board' } }).getTime(), now.getTime() + 15 * 60_000);
});

test('a new posting starts at the first retry interval without inheriting another item’s failures', () => {
  const reason = { code: 'posting_mismatch', scope: 'posting' } as const;
  assert.equal(retainedAtsDetailRetryAt({ now, attemptCount: 199, reason }).getTime(), now.getTime() + 24 * 3600_000);
  assert.equal(retainedAtsDetailRetryAt({ now, attemptCount: 1, reason }).getTime(), now.getTime() + 15 * 60_000);
  for (const attemptCount of [0, -1, Number.NaN]) {
    assert.equal(retainedAtsDetailRetryAt({ now, attemptCount, reason }).getTime(), now.getTime() + 15 * 60_000);
  }
});
