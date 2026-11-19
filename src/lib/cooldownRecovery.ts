import type { Job } from './prismaClient';

import { prisma } from './prisma';
import { verifyJobPosting, type PostingVerification } from './jobPostingVerification';
import { authoritativeJobVerificationUrl } from './verifyJobsAlive';
import { urlMatchesAnyHost } from './urlHost';
import { latestJobScoreEvents, type LatestJobScoreBundle } from './jobScoreAuthorityQuery';
import { resolveStagedScoreAuthority } from './scoreAuthority';
import { nonManualImportSourceWhere } from './manualImportPolicy';
import { activeCompanyCooldowns, cooldownCompanyKey, COOLDOWN_POSTING_CHECK_EVENT,
  effectiveCooldownDeadline, reconcileCompanyCooldowns, resolveInboxAdmission } from './companyCooldown';
import { appliedRepeatDismissalData, findAppliedRepeatForJob, recordAppliedRepeatDismissal } from './appliedDuplicateStore';
import { assertJobLifecycleInvariants, JobLifecycleInvariantError } from './jobLifecycleInvariant';
import { AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE } from './scoringLifecyclePolicy';
import { evaluateAuthoritativeMetadata, hasAuthoritativeMetadata } from './authoritativeMetadataGate';
import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from './userLifecycleAuthority';
import { recordJobPipelineEvent } from './ingestionControl';
import { CLOSED_POSTING_REASON } from './jdRecoveryPolicy';

export type CooldownReleasePlan = {
  status: 'pending_af' | 'inbox' | 'dismissed' | 'expired';
  queueLocalScoring: boolean;
};

type ScoredCooldownReleasePlan = CooldownReleasePlan & {
  status: 'pending_af' | 'inbox' | 'dismissed';
};

export const MAX_COOLDOWN_RELEASES_PER_PASS = 50;
const MAX_COOLDOWN_CHECKS_PER_PASS = 15;
const COOLDOWN_CHECK_RETRY_MS = 15 * 60 * 1000;
const LEGACY_LOCAL_CAP = /\b(?:score capped|capped the score) below triage\b/i;

export class CooldownReleaseHoldError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CooldownReleaseHoldError';
  }
}

export async function processCooldownCandidates<T>(
  candidates: readonly T[],
  release: (candidate: T) => Promise<boolean>,
  onHeld: (candidate: T, error: JobLifecycleInvariantError | CooldownReleaseHoldError) => void | Promise<void>,
  limit = MAX_COOLDOWN_RELEASES_PER_PASS,
): Promise<{ released: number; held: number }> {
  let released = 0;
  let held = 0;
  for (const candidate of candidates) {
    if (released >= limit) break;
    try {
      if (await release(candidate)) released++;
    } catch (error) {
      if (!(error instanceof JobLifecycleInvariantError || error instanceof CooldownReleaseHoldError)) throw error;
      held++;
      await onHeld(candidate, error);
    }
  }
  return { released, held };
}

/** Score-event projection; the cooldown worker also checks persisted local state. */
export function cooldownReleasePlan(bundle: LatestJobScoreBundle | null): ScoredCooldownReleasePlan {
  if (!bundle) return { status: 'pending_af', queueLocalScoring: true };
  const authority = resolveStagedScoreAuthority(bundle);
  if (authority.mode === 'unscored') return { status: 'pending_af', queueLocalScoring: true };
  if (authority.mode === 'legacy') {
    return {
      status: authority.currentLegacy?.passed ? 'inbox' : 'dismissed',
      queueLocalScoring: false,
    };
  }
  if (!authority.currentAim) return { status: 'pending_af', queueLocalScoring: false };
  if (!authority.currentAim.passed) return { status: 'dismissed', queueLocalScoring: false };
  if (!authority.currentExperience) return { status: 'pending_af', queueLocalScoring: false };
  return {
    status: authority.currentExperience.passed ? 'inbox' : 'dismissed',
    queueLocalScoring: false,
  };
}

/** Preserve a job's existing local stage; unresolved old score authority stays held. */
export function cooldownReleasePlanForJob(
  job: Pick<Job, 'scoringStatus' | 'fitScore' | 'aimFitScore' | 'reqFitScore'>,
  bundle: LatestJobScoreBundle | null,
): ScoredCooldownReleasePlan | null {
  if (!bundle) {
    if (job.aimFitScore !== null || job.reqFitScore !== null) return null;
    if (job.scoringStatus === 'scored' && job.fitScore !== null) {
      return { status: 'pending_af', queueLocalScoring: false };
    }
    if (job.scoringStatus === 'needs_jd') {
      return { status: 'pending_af', queueLocalScoring: false };
    }
    if (job.scoringStatus === 'queued' || job.scoringStatus === 'scoring') {
      return { status: 'pending_af', queueLocalScoring: true };
    }
    return null;
  }
  const authority = resolveStagedScoreAuthority(bundle);
  if (authority.mode === 'unscored') return null;
  if (authority.mode === 'legacy' && !authority.currentLegacy) return null;
  if (authority.mode === 'staged' && (
    authority.aimAuthorityState === 'stale_replay_needed'
    || authority.experienceAuthorityState === 'stale_replay_needed'
  )) return null;
  if (authority.mode === 'staged' && job.aimFitScore !== null && !authority.currentAim) return null;
  if (authority.mode === 'staged' && job.reqFitScore !== null && !authority.currentExperience) return null;
  if (authority.mode === 'staged'
    && authority.currentAim?.passed
    && !authority.currentExperience
    && (authority.currentAim.aimFitScore ?? -1) < AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE) return null;
  return cooldownReleasePlan(bundle);
}

/**
 * Some pre-triage local results recorded a cap below triage but still marked
 * the job scored. Only a fresh, independent metadata rejection may complete
 * that old local decision when Cooldown ends. Preserve every stored score and
 * leave score-event authority and explicit user actions alone.
 */
export function legacyCappedCooldownRejection(
  job: Pick<Job, 'title' | 'company' | 'location' | 'url' | 'source' | 'scoringStatus'
    | 'fitScore' | 'fitRationale' | 'aimFitScore' | 'reqFitScore' | 'tailoringStaged'
    | 'batchJobId' | 'jdBatchId' | 'afBatchId'>,
  bundle: LatestJobScoreBundle | null,
  protection: { hasScoreEvent: boolean; hasUserIntent: boolean },
): string | null {
  if (bundle || protection.hasScoreEvent || protection.hasUserIntent || job.tailoringStaged
    || job.scoringStatus !== 'scored' || job.fitScore === null
    || job.aimFitScore !== null || job.reqFitScore !== null
    || job.batchJobId !== null || job.jdBatchId !== null || job.afBatchId !== null
    || !LEGACY_LOCAL_CAP.test(job.fitRationale || '')
    || !hasAuthoritativeMetadata(job.source)) return null;

  const verdict = evaluateAuthoritativeMetadata(job);
  return verdict.passes ? null : verdict.reason;
}

export function statusAfterCooldown(bundle: LatestJobScoreBundle | null): 'pending_af' | 'inbox' | 'dismissed' {
  return cooldownReleasePlan(bundle).status;
}

export async function verifyCooldownPosting(
  job: Pick<Job, 'title' | 'url' | 'canonicalUrl' | 'userCanonicalUrl'>,
  dependencies?: Parameters<typeof verifyJobPosting>[2],
): Promise<PostingVerification> {
  const url = job.userCanonicalUrl || job.canonicalUrl || job.url;
  if (!url) return { liveness: 'inconclusive', probes: [] };
  const workday = urlMatchesAnyHost(url, ['myworkdayjobs.com', 'myworkdaysite.com']);
  return verifyJobPosting(
    { url, title: job.title }, workday ? null : authoritativeJobVerificationUrl(url),
    dependencies, { requireCandidatePage: workday },
  );
}

export async function processCooldownJobs(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  if (signal?.aborted) return;
  const now = new Date();
  const cooldownJobs = await prisma.job.findMany({
    where: {
      status: 'cooldown',
      tailoringStaged: false,
      batchJobId: null,
      jdBatchId: null,
      afBatchId: null,
      AND: [nonManualImportSourceWhere()],
      cooldownUntil: { not: null },
      scoringBatchItems: { none: { status: 'leased' } },
    },
    orderBy: [{ lastVerifiedAt: { sort: 'asc', nulls: 'first' } }, { cooldownUntil: 'asc' }, { id: 'asc' }],
  });
  if (cooldownJobs.length === 0) return;

  const authorities = await activeCompanyCooldowns(prisma, now);
  const retryBefore = new Date(now.valueOf() - COOLDOWN_CHECK_RETRY_MS);
  const expiredCooldowns: Array<{ job: Job; deadline: Date }> = [];
  function unchangedCooldown(job: Job) {
    return { id: job.id, status: 'cooldown', updatedAt: job.updatedAt, cooldownUntil: job.cooldownUntil };
  }

  for (const job of cooldownJobs) {
    if (signal?.aborted) return;
    if (!job.cooldownUntil) continue;
    const deadline = effectiveCooldownDeadline(job.cooldownUntil, authorities.get(cooldownCompanyKey(job)), now);
    if (deadline > now && deadline < job.cooldownUntil) {
      await prisma.job.updateMany({ where: unchangedCooldown(job), data: { cooldownUntil: deadline } });
    } else if (deadline <= now && expiredCooldowns.length < MAX_COOLDOWN_CHECKS_PER_PASS
      && (!job.lastVerifiedAt || job.lastVerifiedAt < deadline || job.lastVerifiedAt <= retryBefore)) {
      expiredCooldowns.push({ job, deadline });
    }
  }
  if (expiredCooldowns.length === 0) return;

  onProgress?.(`Checking ${expiredCooldowns.length} postings whose Cooldown ended.`);
  const scoreBundles = await latestJobScoreEvents(expiredCooldowns.map(({ job }) => job.id));
  const legacyCandidateIds = expiredCooldowns
    .filter(({ job }) => LEGACY_LOCAL_CAP.test(job.fitRationale || ''))
    .map(({ job }) => job.id);
  const [scoreEventRows, userIntentRows] = legacyCandidateIds.length > 0
    ? await Promise.all([
      prisma.jobScoreEvent.findMany({
        where: { jobId: { in: legacyCandidateIds } },
        distinct: ['jobId'],
        select: { jobId: true },
      }),
      prisma.jobPipelineEvent.findMany({
        where: { jobId: { in: legacyCandidateIds }, eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
        distinct: ['jobId'],
        select: { jobId: true },
      }),
    ])
    : [[], []];
  const scoreEventIds = new Set(scoreEventRows.map((row) => row.jobId));
  const userIntentIds = new Set(userIntentRows.map((row) => row.jobId));

  const applyRelease = async (
    job: Job,
    plan: CooldownReleasePlan,
    verification: PostingVerification,
    localRejectionReason: string | null = null,
  ) => {
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const admission = await resolveInboxAdmission({
        jobId: job.id,
        title: job.title,
        location: job.location,
        company: job.company,
        employer: job.employer,
        source: job.source,
        proposedStatus: plan.status,
        now,
        store: tx,
        actor: 'machine',
        completedCooldown: true,
      });
      // A job that repeats an application goes to Dismissed instead of the
      // Inbox, keeping any score it has, and is not queued for scoring. A job
      // headed back to scoring is checked too, so no scoring is spent on it.
      const repeat = admission.repeat
        ?? (plan.status === 'pending_af' ? await findAppliedRepeatForJob(job.id, tx) : null);
      const nextStatus = repeat ? 'dismissed' : admission.status;
      const updated = await tx.job.updateMany({
        where: {
          ...unchangedCooldown(job),
          ...(localRejectionReason ? {
            scoringStatus: 'scored',
            fitScore: job.fitScore,
            fitRationale: job.fitRationale,
            aimFitScore: null,
            reqFitScore: null,
            tailoringStaged: false,
            batchJobId: null,
            jdBatchId: null,
            afBatchId: null,
            scoreEvents: { none: {} },
            scoringBatchItems: { none: { status: 'leased' } },
            pipelineEvents: { none: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } } },
          } : {}),
        },
        data: {
          cooldownUntil: null,
          lastVerifiedAt: now,
          verificationStatus: verification.liveness,
          ...(repeat ? appliedRepeatDismissalData(job, repeat.reason) : {
            status: admission.status,
            ...(plan.status === 'expired' ? { passReason: CLOSED_POSTING_REASON }
              : localRejectionReason ? { passReason: localRejectionReason } : {}),
            ...(plan.queueLocalScoring ? {
              scoringStatus: 'queued',
              batchJobId: null,
              jdBatchId: null,
              afBatchId: null,
              scoreAttempts: 0,
              scoreError: null,
            } : {}),
          }),
        },
      });
      if (updated.count === 1 && repeat) {
        await recordAppliedRepeatDismissal(tx, {
          jobId: job.id,
          source: job.source,
          sourceId: job.sourceId,
          priorStatus: 'cooldown',
          match: repeat,
          route: 'cooldown_release',
        });
      }
      if (updated.count !== 1) return null;
      await recordJobPipelineEvent({
        jobId: job.id,
        eventType: COOLDOWN_POSTING_CHECK_EVENT,
        stage: 'cooldown_release',
        source: job.source,
        sourceId: job.sourceId,
        occurredAt: now,
        identityParts: [job.updatedAt.toISOString()],
        details: { outcome: verification.liveness, probes: verification.probes, nextStatus, enteredInbox: nextStatus === 'inbox' },
      }, tx);
      await assertJobLifecycleInvariants(tx, [job.id]);
      return { status: nextStatus, queueLocalScoring: !repeat && plan.queueLocalScoring };
    });
  };

  const outcome = await processCooldownCandidates(expiredCooldowns, async ({ job, deadline }) => {
    if (signal?.aborted) return false;
    const verification = await verifyCooldownPosting(job);
    if (signal?.aborted) return false;
    if (verification.liveness === 'expired' || verification.liveness === 'unavailable') {
      const released = await applyRelease(job, { status: 'expired', queueLocalScoring: false }, verification);
      if (released) onProgress?.(`Expired ${job.title} after the Cooldown posting check.`);
      return released !== null;
    }

    const bundle = scoreBundles.get(job.id) || null;
    const plan = cooldownReleasePlanForJob(job, bundle);
    if (verification.liveness !== 'alive' || !plan) {
      const held = await prisma.job.updateMany({
        where: unchangedCooldown(job),
        data: { cooldownUntil: deadline, lastVerifiedAt: new Date(), verificationStatus: verification.liveness },
      });
      if (held.count === 1) throw new CooldownReleaseHoldError(verification.liveness === 'alive'
        ? 'Existing scoring state has no safe automatic release plan.'
        : 'Posting availability is inconclusive.');
      return false;
    }
    const localRejectionReason = legacyCappedCooldownRejection(job, bundle, {
      hasScoreEvent: scoreEventIds.has(job.id),
      hasUserIntent: userIntentIds.has(job.id),
    });
    const released = localRejectionReason
      ? await applyRelease(job, { status: 'dismissed', queueLocalScoring: false }, verification, localRejectionReason)
      : await applyRelease(job, plan, verification);
    if (released) onProgress?.(
      localRejectionReason
        ? `Job ${job.id} locally rejected on Cooldown release: ${localRejectionReason}`
        : released.queueLocalScoring
          ? `Job ${job.id} released to current local scoring.`
          : `Job ${job.id} restored to ${released.status}.`,
    );
    return released !== null;
  }, async ({ job, deadline }, error) => {
    const reason = error instanceof JobLifecycleInvariantError
      ? error.violations.map((item) => item.invariant).join(', ')
      : error.message;
    if (error instanceof JobLifecycleInvariantError) {
      // Defer the contradictory row so it cannot take the first slot on every
      // pass. The rejected transition and its receipt were both rolled back.
      await prisma.job.updateMany({
        where: unchangedCooldown(job),
        data: { cooldownUntil: deadline, lastVerifiedAt: new Date() },
      });
    }
    console.warn(`Cooldown release held ${job.id}: ${reason}`);
  });
  onProgress?.(`Processed ${outcome.released} completed Cooldown holds. ${outcome.held} are waiting for another check.`);
}

export async function enforceRetroactiveCooldowns(onProgress?: (msg: string) => void) {
  onProgress?.('Checking Inbox for employer cooldowns triggered by recent application pairs.');
  const cooledIds = await prisma.$transaction(async (tx) => {
    const ids = await reconcileCompanyCooldowns({ now: new Date(), store: tx });
    await assertJobLifecycleInvariants(tx, ids);
    return ids;
  });
  if (cooledIds.length > 0) {
    onProgress?.(`Moved ${cooledIds.length} Inbox jobs to cooldown because of recent applications.`);
  }
}
