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
