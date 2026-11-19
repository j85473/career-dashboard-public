import type { Job, Prisma } from './prismaClient';
import { automatedLifecycleIsProtected, nonManualImportSourceWhere } from './manualImportPolicy';
import { derivePostingFacts } from './postingFacts';
import { parseHttpUrl } from './urlHost';

export const CUSTOMER_SUCCESS_EXCLUSION_REASON = 'Locally triaged out: Customer/client success role excluded by user preference';
export const ATT_FIELD_SALES_EXCLUSION_REASON = 'Locally triaged out: Role excluded from local scoring (AT&T Field Sales Representative)';
export const PART_TIME_EXCLUSION_REASON = 'Locally triaged out: Posting explicitly identifies the job as part-time';

const ATT_EMPLOYER_ALIASES = new Set([
  'at&t', 'at&t inc', 'at&t inc.', 'at&t, inc', 'at&t, inc.',
  'at&t mobility services', 'at&t mobility services llc', 'at&t mobility services, llc',
]);

/** Match the occupation in the title, never incidental CS duties in the JD. */
export function isExcludedCustomerSuccessTitle(title: string): boolean {
  const normalized = title.replace(/[-\u2010-\u2015]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b(?:(?:customer|client)\s+success|csm)\b/i.test(normalized)) return false;

  // Preserve explicit account-management and partner/channel occupations,
  // including titles such as "Partner Success Specialist, Customer Success".
  const retainedOccupation = /\baccount\s+(?:manager|management|director|executive)\b|\b(?:partner|channel|distributor|distribution)\s+(?:success|(?:account\s+)?(?:manager|management|director|specialist|lead|sales))\b/i;
  return !retainedOccupation.test(normalized);
}

type PostingIdentity = Pick<Job, 'title' | 'company' | 'url' | 'canonicalUrl'>;
type ResolvedPosting = PostingIdentity & { resolvedDescription?: string };
type IntakeJob = PostingIdentity
  & Pick<Job, 'id' | 'status' | 'source' | 'description' | 'tailoringStaged' | 'fitScore' | 'aimFitScore' | 'reqFitScore' | 'travelScore'>;
type WriteExclusion = (args: Prisma.JobUpdateManyArgs) => Promise<{ count: number }>;

const PART_TIME = /\bpart[ -]+time\b/i;
const FULL_TIME = /\bfull[ -]+time\b/i;
const ALTERNATIVE_SCHEDULE = /\b(?:part|full)[ -]*(?:\/|or\b|and\b)[ -]*(?:part|full)[ -]+time\b/i;
const TITLE_PART_TIME = /(?:^part[ -]+time\b|\bpart[ -]+time$|(?:[([|,:]| -)\s*part[ -]+time(?=\s*(?:[\]),|:-]|$)))/i;
const SCHEDULE_FIELD = /^[ \t]*(?:[-*•] +)?(?:employment(?: type| status)?|job type|position type|time type|work type|work schedule|schedule(?: type)?) *(?::\s*|\r?\n\s*)((?:(?:regular|permanent|temporary)[ ,/-]+)?(?:part|full)[ -]+time\b[^\r\n]*)/gim;
const SCHEDULE_STATEMENT = /\b(?:this (?:is an? )?(?:regular )?(?:part|full)[ -]+time (?:job|role|position|opening|opportunity)\b|(?:this|the) (?:job|role|position|opening) (?:is|will be) (?:an? )?(?:regular )?(?:part|full)[ -]+time\b(?! (?:eligible|preferred|optional|only if)\b))(?: *(?:\( *)?(?:[/&+,]|and\b|or\b) *(?:an? )?(?:part|full)[ -]+time\b)?/gi;

function isExplicitlyPartTime(title: string, description: string): boolean {
  const normalizedTitle = title.replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
  if (FULL_TIME.test(normalizedTitle) || ALTERNATIVE_SCHEDULE.test(normalizedTitle)) return false;

  // Only use fields and statements that identify the schedule of this opening.
  // The rest of the JD may mention part-time staff, experience, or benefits.
  const text = description
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\*\*|__/g, '')
    .replace(/\b(part|full)_time\b/gi, '$1-time')
    .replace(/[^\S\r\n]+/g, ' ');
  const evidence = [
    ...Array.from(text.matchAll(SCHEDULE_FIELD), match => match[1]),
    ...Array.from(text.matchAll(SCHEDULE_STATEMENT), match => match[0]),
  ];
  if (evidence.some(value => FULL_TIME.test(value) || ALTERNATIVE_SCHEDULE.test(value))) return false;

  return TITLE_PART_TIME.test(normalizedTitle) || evidence.some(value => PART_TIME.test(value));
}

function roleExclusionReason(posting: ResolvedPosting): string | null {
  if (isExcludedCustomerSuccessTitle(posting.title)) return CUSTOMER_SUCCESS_EXCLUSION_REASON;
  if (posting.resolvedDescription !== undefined && isExplicitlyPartTime(posting.title, posting.resolvedDescription)) {
    return PART_TIME_EXCLUSION_REASON;
  }
  if (posting.title.trim().replace(/\s+/g, ' ').toLowerCase() !== 'field sales representative') return null;

  const company = posting.company.trim().replace(/\s+/g, ' ').toLowerCase();
  const isAttPosting = ATT_EMPLOYER_ALIASES.has(company)
    || [posting.url, posting.canonicalUrl].some(url => parseHttpUrl(url)?.hostname === 'att.wd1.myworkdayjobs.com');
  return isAttPosting ? ATT_FIELD_SALES_EXCLUSION_REASON : null;
}

/**
 * A prospective local-scoring decision for untouched intake only. Repeat every
 * protection in the atomic write so a concurrent score or human action wins.
 * Neither existing scores nor scoring artifacts are changed or invalidated.
 */
export async function filterNewIntakeRole(
  job: IntakeJob,
  leaseId: string,
  write: WriteExclusion,
  posting: ResolvedPosting = job,
): Promise<string | null> {
  if (job.status !== 'pending_af' || job.tailoringStaged
    || automatedLifecycleIsProtected(job)
    || [job.fitScore, job.aimFitScore, job.reqFitScore, job.travelScore].some((score) => score !== null)) return null;

  const reason = roleExclusionReason(posting);
  if (!reason) return null;
  const partTime = reason === PART_TIME_EXCLUSION_REASON;

  const result = await write({
    where: {
      id: job.id,
      title: job.title,
      company: job.company,
      url: job.url,
      canonicalUrl: job.canonicalUrl,
      ...(partTime ? { description: job.description } : {}),
      status: 'pending_af',
      scoringStatus: 'scoring',
      batchJobId: leaseId,
      tailoringStaged: false,
      fitScore: null,
      aimFitScore: null,
      reqFitScore: null,
      travelScore: null,
      AND: [nonManualImportSourceWhere()],
      scoreEvents: { none: {} },
      scoringArtifacts: { none: {} },
      aimFactualExtractions: { none: {} },
      statusHistory: { none: { status: { not: 'pending_af' } } },
    },
    data: {
      status: 'dismissed',
      scoringStatus: 'skipped',
      passReason: reason,
      ...(posting.title !== job.title ? { title: posting.title } : {}),
      ...(posting.company !== job.company ? { company: posting.company } : {}),
      ...(partTime && posting.resolvedDescription !== job.description
        ? { description: posting.resolvedDescription, ...derivePostingFacts(posting.resolvedDescription) }
        : {}),
      batchJobId: null,
      scoreAttempts: 0,
      scoreError: null,
    },
  });
  return result.count === 1 ? reason : null;
}
