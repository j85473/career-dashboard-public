import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CooldownReleaseHoldError,
  cooldownReleasePlan,
  cooldownReleasePlanForJob,
  legacyCappedCooldownRejection,
  processCooldownCandidates,
  statusAfterCooldown,
  verifyCooldownPosting,
} from '../cooldownRecovery';
import { JobLifecycleInvariantError } from '../jobLifecycleInvariant';
import type { LatestJobScoreBundle } from '../jobScoreAuthorityQuery';
import { AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE } from '../scoringLifecyclePolicy';

test('Cooldown verification prefers the employer URL and distinguishes live, closed, and blocked responses', async () => {
  const job = {
    title: 'Partner Manager',
    url: 'https://aggregator.example/jobs/123',
    canonicalUrl: 'https://careers.example/jobs/123',
    userCanonicalUrl: null,
  };
  const description = 'Responsibilities include enabling channel partners and managing account plans. '
    + 'Qualifications include business development experience and demonstrated account growth. '.repeat(15);
  const live = await verifyCooldownPosting(job, {
    fetchPosting: async url => {
      assert.equal(url, job.canonicalUrl);
      return new Response(`<h1>${job.title}</h1><p>${description}</p>`);
    },
  });
  assert.equal(live.liveness, 'alive');
  assert.equal((await verifyCooldownPosting(job, {
    fetchPosting: async () => new Response('', { status: 410 }),
  })).liveness, 'expired');
  assert.equal((await verifyCooldownPosting(job, {
    fetchPosting: async () => new Response('', { status: 429 }),
    readPosting: async () => { throw new Error('reader unavailable'); },
  })).liveness, 'inconclusive');
});

test('Cooldown verification checks the chosen public Workday page for closure', async () => {
  const url = 'https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/US/Partner-Manager_R123';
  const result = await verifyCooldownPosting({ title: 'Partner Manager', url: null, canonicalUrl: null, userCanonicalUrl: url }, {
    fetchPosting: async input => {
      assert.equal(input, url);
      return new Response('<title>Careers</title>');
    },
    readPosting: async () => new Response(`Title: Careers\n\nURL Source: ${url}\n\nMarkdown Content:\nThe page you are looking for doesn't exist.`),
  });
  assert.equal(result.liveness, 'expired');
});

test('an expired Cooldown row without score authority re-enters current local scoring', () => {
  assert.deepEqual(cooldownReleasePlan(null), {
    status: 'pending_af',
    queueLocalScoring: true,
  });
  assert.equal(statusAfterCooldown(null), 'pending_af');
});

test('an empty score bundle is treated as unscored and cannot bypass local scoring', () => {
  const emptyBundle = {
    legacy: null,
    aim: null,
    experience: null,
    cleanedArtifact: null,
    aimExtraction: null,
  } satisfies LatestJobScoreBundle;
  assert.deepEqual(cooldownReleasePlan(emptyBundle), {
    status: 'pending_af',
    queueLocalScoring: true,
  });
});

test('current legacy score authority keeps its existing lifecycle projection', () => {
  const bundle = {
    legacy: {
      evaluationType: 'standard',
      staleAt: null,
      passed: true,
    },
    aim: null,
    experience: null,
    cleanedArtifact: null,
    aimExtraction: null,
  } as unknown as LatestJobScoreBundle;
  assert.deepEqual(cooldownReleasePlan(bundle), {
    status: 'inbox',
    queueLocalScoring: false,
  });
});

test('expired cooldown keeps an existing local score out of automatic rescoring', () => {
  assert.deepEqual(cooldownReleasePlanForJob({
    scoringStatus: 'scored', fitScore: 83, aimFitScore: null, reqFitScore: null,
  }, null), { status: 'pending_af', queueLocalScoring: false });
  assert.deepEqual(cooldownReleasePlanForJob({
    scoringStatus: 'needs_jd', fitScore: null, aimFitScore: null, reqFitScore: null,
  }, null), { status: 'pending_af', queueLocalScoring: false });
  assert.equal(cooldownReleasePlanForJob({
    scoringStatus: 'skipped', fitScore: 83, aimFitScore: null, reqFitScore: null,
  }, null), null);
  assert.equal(cooldownReleasePlanForJob({
    scoringStatus: 'scored', fitScore: 83, aimFitScore: 72, reqFitScore: null,
  }, null), null);
});

test('old locally capped clinical posting is rejected on release without changing its stored score', () => {
  const job = {
    title: 'Neuropsychologist - Contract (1099) - Indiana',
    company: 'Lyrahealth',
    location: 'Indianapolis, Indiana',
    url: 'https://jobs.lever.co/lyrahealth/example',
    source: 'ATS-lever',
    scoringStatus: 'scored',
    fitScore: 52,
    fitRationale: 'No target sales, account management, partnerships, or customer success title signal; score capped below triage.',
    aimFitScore: null,
    reqFitScore: null,
    tailoringStaged: false,
    batchJobId: null,
    jdBatchId: null,
    afBatchId: null,
  };
  const protection = { hasScoreEvent: false, hasUserIntent: false };
  assert.match(legacyCappedCooldownRejection(job, null, protection) || '', /outside the searched geographies/);
  assert.equal(legacyCappedCooldownRejection(job, null, { ...protection, hasScoreEvent: true }), null);
  assert.equal(legacyCappedCooldownRejection(job, null, { ...protection, hasUserIntent: true }), null);
  assert.equal(legacyCappedCooldownRejection({ ...job, afBatchId: 'leased' }, null, protection), null);
  assert.equal(legacyCappedCooldownRejection({ ...job, fitRationale: 'Current scored result' }, null, protection), null);
  assert.equal(legacyCappedCooldownRejection({ ...job, title: 'Territory Sales Executive', location: 'United States' }, null, protection), null);
});

test('an old invalidated Experience event cannot send a stored Experience score backward to Aim', () => {
  const bundle = {
    legacy: null,
    aim: { evaluationType: 'aim_fit', passed: true, aimFitScore: 72, staleAt: null },
    experience: { evaluationType: 'experience_fit', passed: true, experienceFitScore: 78, staleAt: new Date(), staleReason: 'global-scoring-input-version-changed' },
    cleanedArtifact: null,
    aimExtraction: null,
  } as unknown as LatestJobScoreBundle;
  assert.equal(cooldownReleasePlanForJob({
    scoringStatus: 'scored', fitScore: 80, aimFitScore: 72, reqFitScore: 78,
  }, bundle), null);
  assert.equal(cooldownReleasePlanForJob({
    scoringStatus: 'scored', fitScore: 80, aimFitScore: 72, reqFitScore: null,
  }, bundle), null);
});

test('an Experience event without Aim authority remains held even if local scores are blank', () => {
  const bundle = {
    legacy: null,
    aim: null,
    experience: { evaluationType: 'experience_fit', passed: true, staleAt: null },
    cleanedArtifact: null,
    aimExtraction: null,
  } as unknown as LatestJobScoreBundle;
  assert.equal(cooldownReleasePlanForJob({
    scoringStatus: 'scored', fitScore: null, aimFitScore: null, reqFitScore: null,
  }, bundle), null);
});

test('a passing Aim score below the existing queue floor cannot release into the wrong stage', () => {
  const bundle = {
    legacy: null,
    aim: { evaluationType: 'aim_fit', passed: true, aimFitScore: AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE - 1, staleAt: null },
    experience: null,
    cleanedArtifact: null,
    aimExtraction: null,
  } as unknown as LatestJobScoreBundle;
  assert.equal(cooldownReleasePlanForJob({
    scoringStatus: 'scored', fitScore: 82, aimFitScore: AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE - 1, reqFitScore: null,
  }, bundle), null);
});

test('an invalidated legacy score stays held instead of being dismissed on release', () => {
  const bundle = {
    legacy: { evaluationType: 'standard', passed: true, staleAt: new Date(), staleReason: 'historical-invalidated-score' },
    aim: null,
    experience: null,
    cleanedArtifact: null,
    aimExtraction: null,
  } as unknown as LatestJobScoreBundle;
  assert.equal(cooldownReleasePlanForJob({
    scoringStatus: 'scored', fitScore: 83, aimFitScore: 80, reqFitScore: 82,
  }, bundle), null);
});

test('one conflicting scored cooldown cannot block later releases', async () => {
  const attempted: number[] = [];
  const held: number[] = [];
  const outcome = await processCooldownCandidates([1, 2, 3], async (job) => {
    attempted.push(job);
    if (job === 1) throw new JobLifecycleInvariantError([]);
    return true;
  }, (job) => { held.push(job); });
  assert.deepEqual(outcome, { released: 2, held: 1 });
  assert.deepEqual(attempted, [1, 2, 3]);
  assert.deepEqual(held, [1]);
});

test('a cooldown turn limits successful releases without being trapped by held rows', async () => {
  const attempted: number[] = [];
  const outcome = await processCooldownCandidates([1, 2, 3], async (job) => {
    attempted.push(job);
    if (job === 1) throw new JobLifecycleInvariantError([]);
    return true;
  }, () => {}, 1);
  assert.deepEqual(outcome, { released: 1, held: 1 });
  assert.deepEqual(attempted, [1, 2]);
});

test('a held legacy state does not count against the release limit', async () => {
  const outcome = await processCooldownCandidates([1, 2], async (job) => {
    if (job === 1) throw new CooldownReleaseHoldError('ambiguous legacy state');
    return true;
  }, () => {}, 1);
  assert.deepEqual(outcome, { released: 1, held: 1 });
});

test('database failures still stop cooldown recovery for diagnosis', async () => {
  await assert.rejects(
    processCooldownCandidates([1, 2], async () => {
      throw new Error('database unavailable');
    }, () => {}),
    /database unavailable/,
  );
});
