import { randomUUID } from 'node:crypto';
import type { Job, Prisma } from './prismaClient';

import { appliedIdentityFingerprint } from './appliedDuplicateIdentity';
import {
  findAppliedDuplicateEvidence,
  findAppliedRepeatForJob,
  repeatExceptionAuthorityIds,
  type AppliedRepeatAuthority,
  type AppliedRepeatMatch,
} from './appliedDuplicateStore';
import { buildAppliedDuplicateReason, type AppliedDuplicateAuthorityJob } from './appliedDuplicatePolicy';
import { recordJobPipelineEvent } from './ingestionControl';

import { employerIdentityKey } from './employerIdentity';
import { isManualImportSource, nonManualImportSourceWhere } from './manualImportPolicy';
import { normalizeDirectPostingUrl } from './atsDirectMatch';

export const COMPANY_COOLDOWN_DAYS = 5;
export const COOLDOWN_POSTING_CHECK_EVENT = 'cooldown_posting_verified';
const COMPANY_COOLDOWN_MS = COMPANY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const ACTIVE_APPLICATION_STATUSES = ['applied', 'interviewing'] as const;

// Match real employers, using the canonical name or the unresolved raw company.
// Shared publishers cannot establish a cooldown for unrelated employers.
export function cooldownCompanyKey(job: { employer?: string | null; company?: string | null }): string {
  return employerIdentityKey(job, { excludeSharedPublishers: true });
}

type CompanyCooldownStore = Pick<Prisma.TransactionClient, 'job'>;
type InboxAdmissionStore = Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;

type ApplicationAuthority = {
  id: string;
  decisionAt: Date;
  cooldownUntil: Date;
};

export type InboxAdmission = {
  status: string;
  cooldownUntil: Date | null;
  authorityJobId: string | null;
  authorityDecisionAt: Date | null;
  /** Exact-identity repost found on one of Joseph's own promote or restore actions. */
  appliedDuplicate?: AppliedDuplicateAuthorityJob;
  /** Same-role repeat found on a machine path (scoring import, Cooldown ending). */
  repeat: AppliedRepeatMatch | null;
  /** Why the job was dismissed instead of admitted, for either kind of match. */
  passReason?: string;
};

export function companyCooldownUntil(decisionAt: Date): Date {
  return new Date(decisionAt.valueOf() + COMPANY_COOLDOWN_MS);
}

/** The first transition in the current contiguous Applied/Interviewing run. */
export function activeApplicationDecisionAt(
  historiesNewestFirst: readonly { status: string; createdAt: Date }[],
  fallback: Date,
): Date {
  let decisionAt: Date | null = null;
  for (const history of historiesNewestFirst) {
    if ((ACTIVE_APPLICATION_STATUSES as readonly string[]).includes(history.status)) {
      decisionAt = history.createdAt;
      continue;
    }
    if (decisionAt) break;
  }
  return decisionAt || fallback;
}

type ApplicationRow = Pick<Job, 'id' | 'company' | 'employer' | 'postingIdentity' | 'url' | 'canonicalUrl' | 'updatedAt'> & {
  statusHistory: Array<{ status: string; createdAt: Date }>;
};

export async function activeCompanyCooldowns(
  store: CompanyCooldownStore,
  now: Date,
  excludeJobId?: string,
): Promise<Map<string, ApplicationAuthority>> {
  const jobs = await store.job.findMany({
    where: {
      status: { in: [...ACTIVE_APPLICATION_STATUSES] },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
    },
    select: {
      id: true,
      company: true,
      employer: true,
      postingIdentity: true,
      url: true,
      canonicalUrl: true,
      updatedAt: true,
      statusHistory: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: { status: true, createdAt: true },
      },
    },
  });

  // Work from oldest to newest so more applications during an open window
  // do not move the deadline set by the qualifying second application.
  const applications = jobs.map((job: ApplicationRow) => ({ ...job,
    decisionAt: activeApplicationDecisionAt(job.statusHistory, job.updatedAt),
  })).sort((a, b) => a.decisionAt.valueOf() - b.decisionAt.valueOf() || a.id.localeCompare(b.id));
  const recentByCompany = new Map<string, Date>();
  const cooldowns = new Map<string, ApplicationAuthority>();
  const seenPostings = new Set<string>();
  for (const job of applications) {
    const company = cooldownCompanyKey(job);
    if (!company || job.decisionAt > now) continue;
    const keys = [job.postingIdentity, normalizeDirectPostingUrl(job.canonicalUrl || job.url || '')]
      .filter((key): key is string => Boolean(key)).map(key => `${company}\n${key}`);
    const counted = keys.some(key => seenPostings.has(key));
    for (const key of keys) seenPostings.add(key);
    if (counted) continue;

    const previous = recentByCompany.get(company);
    recentByCompany.set(company, job.decisionAt);
    const current = cooldowns.get(company);
    if (previous && job.decisionAt.valueOf() - previous.valueOf() <= COMPANY_COOLDOWN_MS
      && (!current || current.cooldownUntil <= job.decisionAt)) {
      cooldowns.set(company, { id: job.id, decisionAt: job.decisionAt, cooldownUntil: companyCooldownUntil(job.decisionAt) });
    }
  }
  for (const [company, authority] of cooldowns) {
    if (authority.cooldownUntil <= now) cooldowns.delete(company);
  }
  return cooldowns;
}

/** A new rule can shorten a saved hold, while its original deadline is a cap. */
export function effectiveCooldownDeadline(saved: Date, authority: ApplicationAuthority | undefined, now: Date): Date {
  const current = authority?.cooldownUntil || now;
  return saved < current ? saved : current;
}

/**
 * Applies the same admission decision to every path that wants to enter Inbox.
 * Manual Imports remain user-controlled and bypass automated lifecycle policy.
 *
 * `actor` decides how a repeat of an applied job is recognized. Machine paths
 * (a scoring import promoting a job, Cooldown ending) use the same-role test,
 * which also catches copies from other sites. Joseph's own promote and restore
 * buttons are blocked only by an exact company/title/location repost, as they
 * have been since 2026-09-07. Both honor a "Not a repeat" decision for the pair.
 */
export async function resolveInboxAdmission(input: {
  jobId: string;
  title: string;
  location: string | null;
  company: string | null | undefined;
  /** The job's canonical employer; null for a row the employer pass has not reached. */
  employer: string | null | undefined;
  source: string | null | undefined;
  proposedStatus: string;
  now: Date;
  store: InboxAdmissionStore;
  actor: 'machine' | 'user';
  /** A card whose hold has ended still goes through the repost check. */
  completedCooldown?: boolean;
  /** A caller admitting many jobs in one transaction reads the applied list once and passes it here. */
  repeatAuthorities?: readonly AppliedRepeatAuthority[];
}): Promise<InboxAdmission> {
  const admitted = { status: 'inbox', cooldownUntil: null, authorityJobId: null, authorityDecisionAt: null, repeat: null };
  if (input.proposedStatus !== 'inbox' || isManualImportSource(input.source)) {
    return { ...admitted, status: input.proposedStatus };
  }

  if (input.actor === 'machine') {
    const repeat = await findAppliedRepeatForJob(input.jobId, input.store, { authorities: input.repeatAuthorities });
    if (repeat) {
      return {
        status: 'dismissed',
        cooldownUntil: null,
        authorityJobId: repeat.authority.id,
        authorityDecisionAt: null,
        repeat,
        passReason: repeat.reason,
      };
    }
  } else {
    // Reposts are an all-time application decision, independent of the
    // employer's temporary cooldown. Evaluate the proposed Inbox state so a
    // Cooldown row cannot bypass this check merely because its current status
    // is protected.
    const appliedDuplicate = await findAppliedDuplicateEvidence({
      id: input.jobId,
      identityFingerprint: appliedIdentityFingerprint({
        title: input.title, company: input.company || '', location: input.location,
      }),
      location: input.location,
      status: 'inbox',
    }, input.store, { recomputeAuthorityIdentity: true });
    if (appliedDuplicate && !(await repeatExceptionAuthorityIds(input.store, input.jobId)).has(appliedDuplicate.id)) {
      return {
        status: 'dismissed',
        cooldownUntil: null,
        authorityJobId: appliedDuplicate.id,
        authorityDecisionAt: null,
        appliedDuplicate,
        repeat: null,
        passReason: buildAppliedDuplicateReason(appliedDuplicate),
      };
    }
  }

  const company = cooldownCompanyKey(input);
  if (input.completedCooldown || !company) return admitted;
  const authority = (await activeCompanyCooldowns(input.store, input.now, input.jobId)).get(company);
  if (!authority) return admitted;
  return {
    status: 'cooldown',
    cooldownUntil: authority.cooldownUntil,
    authorityJobId: authority.id,
    authorityDecisionAt: authority.decisionAt,
    repeat: null,
  };
}

/** Park current Inbox rows when a recent pair of applications qualifies. */
export async function parkSameCompanyInboxJobs(input: {
  authorityJobId: string;
  company: string | null | undefined;
  employer?: string | null;
  now: Date;
  store: CompanyCooldownStore;
}): Promise<string[]> {
  const company = cooldownCompanyKey(input);
  if (!company) return [];
  const authority = (await activeCompanyCooldowns(input.store, input.now)).get(company);
  if (!authority) return [];
  return parkInboxJobs(input.store, new Map([[company, authority]]), input.authorityJobId);
}

/** Repair only current Inbox rows; prior decisions and scores are untouched. */
export async function reconcileCompanyCooldowns(input: {
  now: Date;
  store: CompanyCooldownStore;
}): Promise<string[]> {
  return parkInboxJobs(input.store, await activeCompanyCooldowns(input.store, input.now));
}

async function parkInboxJobs(store: CompanyCooldownStore, authorities: Map<string, ApplicationAuthority>, excludedJobId?: string) {
  if (authorities.size === 0) return [];
  const candidates = await store.job.findMany({
    where: { status: 'inbox', AND: [nonManualImportSourceWhere()], ...(excludedJobId ? { id: { not: excludedJobId } } : {}) },
    select: { id: true, company: true, employer: true },
  });
  const cooledIds: string[] = [];
  for (const candidate of candidates) {
    const authority = authorities.get(cooldownCompanyKey(candidate));
    if (!authority) continue;
    const cooled = await store.job.updateMany({
      where: {
        id: candidate.id,
        status: 'inbox',
        AND: [nonManualImportSourceWhere()],
        // A release that occurred during this window must remain in Inbox.
        pipelineEvents: { none: {
          eventType: COOLDOWN_POSTING_CHECK_EVENT,
          occurredAt: { gte: authority.decisionAt },
          details: { path: ['nextStatus'], equals: 'inbox' },
        } },
      },
      data: { status: 'cooldown', cooldownUntil: authority.cooldownUntil },
    });
    if (cooled.count === 1) cooledIds.push(candidate.id);
  }
  return cooledIds;
}

/** Record the application decision behind a blocked admission in the same
 * transaction as the lifecycle write. Scores remain valid and untouched.
 */
export async function recordAppliedRepostAdmission(
  input: { jobId: string; source: string | null | undefined; admission: InboxAdmission },
  store: Pick<Prisma.TransactionClient, 'jobPipelineEvent'>,
): Promise<void> {
  const authority = input.admission.appliedDuplicate;
  if (!authority) return;
  await recordJobPipelineEvent({
    eventType: 'user_lifecycle',
    jobId: input.jobId,
    stage: 'human_decision',
    source: input.source || null,
    identityParts: ['applied_repost_admission', authority.id, input.jobId, randomUUID()],
    details: {
      actor: 'user', protected: true, derived: true,
      originDecisionJobId: authority.id,
      originDecisionStatus: authority.status,
      duplicateReason: input.admission.passReason,
      nextStatus: 'dismissed',
    },
  }, store);
}
