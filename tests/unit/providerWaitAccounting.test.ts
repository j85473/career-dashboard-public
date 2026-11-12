import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestionSourceRunStatus, recordSourceRunFailure } from '../../src/lib/jobIngestion';
import { classifyIngestionTaskCompletion, classifyProviderFailure } from '../../src/lib/ingestionControl';
import { requireUnchallengedProviderResponse } from '../../src/lib/providerAccessChallenge';

const counts = (seen = 0) => ({ seen, inserted: 0, duplicates: seen, filtered: 0,
  requestErrors: 0, processingErrors: 0, lastError: null as string | null });

test('budget waits have no request errors, keep their outcomes, and remain scheduled as waits', () => {
  for (const reason of ['daily_budget', 'monthly_budget', 'paced_budget', 'enrichment_budget']) {
    for (const seen of [0, 10]) {
      const stats = counts(seen);
      recordSourceRunFailure(stats, new Error(`JSearch request blocked by ${reason}`));
      assert.equal(stats.requestErrors, 0);
      assert.equal(stats.duplicates, seen);
      assert.equal(ingestionSourceRunStatus(stats), 'blocked_budget');
      assert.equal(classifyIngestionTaskCompletion({ sourceStatuses: [ingestionSourceRunStatus(stats)], lastErrors: [stats.lastError] }), 'blocked_budget');
    }
  }
  const stats = counts();
  recordSourceRunFailure(stats, Error('JSearch request blocked by circuit_open'));
  assert.equal(stats.requestErrors, 0);
  assert.equal(ingestionSourceRunStatus(stats), 'blocked_circuit');
  assert.equal(classifyIngestionTaskCompletion({ sourceStatuses: [ingestionSourceRunStatus(stats)] }), 'blocked_circuit');
});

test('a later wait cannot erase a real request failure, including one retained by key rotation', () => {
  const stats = counts();
  recordSourceRunFailure(stats, Error('HTTP 503'));
  recordSourceRunFailure(stats, Error('JSearch request blocked by paced_budget'));
  assert.equal(stats.requestErrors, 1);
  assert.equal(stats.lastError, 'HTTP 503');
  assert.equal(ingestionSourceRunStatus(stats), 'failed');
  const rotated = { ...counts(), stageEvidence: { previousFailure: 'transport failure (ETIMEDOUT)' } };
  assert.equal(recordSourceRunFailure(rotated, Error('JSearch request blocked by paced_budget')), 'provider_error');
  assert.equal(rotated.requestErrors, 1);
  assert.equal(rotated.lastError, 'transport failure (ETIMEDOUT)');
});

test('explicit challenge headers explain access failures without leaking challenge tokens', async () => {
  for (const [source, status, header, protection] of [
    ['BioSpace', 429, 'x-vercel-mitigated', 'Vercel'], ['TheMuse', 403, 'cf-mitigated', 'Cloudflare'],
  ] as const) {
    const response = new Response('private challenge token', { status, headers: { [header]: 'challenge' } });
    await assert.rejects(requireUnchallengedProviderResponse(source, response), (error: Error) => {
      assert.equal(classifyProviderFailure(error), 'access_challenge');
      assert.match(error.message, new RegExp(protection));
      assert.doesNotMatch(error.message, /private challenge token/);
      return true;
    });
    assert.equal(response.bodyUsed, true);
  }
  await requireUnchallengedProviderResponse('TheMuse', new Response('{}', { status: 403 }));
  assert.equal(classifyProviderFailure(Error('HTTP 403')), 'credentials');
  assert.equal(classifyProviderFailure(Error('BioSpace HTTP 429')), 'rate_limited');
});
