import assert from 'node:assert/strict';
import test from 'node:test';
import { firstCollectionCandidateQuery } from '../../src/lib/atsFirstCollectionFairness';

test('capacity validation rotates providers while preserving retry and candidate eligibility', () => {
  const query = firstCollectionCandidateQuery(new Date('2026-11-11T22:00:00Z'));
  assert.match(query.text, /MAX\("lastValidationStartedAt"\)/);
  assert.match(query.text, /candidate\.state='discovered'/);
  assert.match(query.text, /candidate\."nextValidationAt" <=/);
  assert.match(query.text, /ORDER BY turns\.last_started ASC NULLS FIRST, candidate\."createdAt" ASC/);
  assert.match(query.text, /LIMIT 1/);
  assert.doesNotMatch(query.text, /UPDATE|DELETE|INSERT|"Job"/);
});

test('reviewed validation filters to the enrolled providers and an empty selection admits nothing', () => {
  const query = firstCollectionCandidateQuery(new Date('2026-11-11T22:00:00Z'), ['homerun', 'softgarden']);
  assert.deepEqual(query.values.slice(0, -1), ['homerun', 'softgarden']);
  assert.match(firstCollectionCandidateQuery(new Date(), []).text, /AND FALSE/);
  assert.match(firstCollectionCandidateQuery(new Date(), ['unregistered-provider']).text, /AND FALSE/);
});
