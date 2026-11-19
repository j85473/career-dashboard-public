import { formatStructuredDollarRange } from './postedCompensation';

type PostingIdentity = { board: string; id: string };
const periods = new Map([['HOURLY', 'hour'], ['DAILY', 'day'], ['WEEKLY', 'week'], ['MONTHLY', 'month'], ['YEARLY', 'year']]);
const refreshStatuses = new Set(['pending_af', 'inbox', 'cooldown', 'applied', 'interviewing']);

export function smartRecruitersCompensationRefreshEligible(status: string | null): boolean {
  return status !== null && refreshStatuses.has(status);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function smartRecruitersPostingIdentity(value: string | null | undefined): PostingIdentity | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['jobs.smartrecruiters.com', 'careers.smartrecruiters.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/([\w-]+)\/(\d+)(?:-[^/]+)?\/?$/);
    return match ? { board: match[1], id: match[2] } : null;
  } catch {
    return null;
  }
}

export function sameSmartRecruitersPosting(first: string | null | undefined, second: string | null | undefined): boolean {
  const a = smartRecruitersPostingIdentity(first);
  const b = smartRecruitersPostingIdentity(second);
  return Boolean(a && b && a.id === b.id && a.board.toLowerCase() === b.board.toLowerCase());
}

export function smartRecruitersPostingDetailUrl({ board, id }: PostingIdentity): string {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings/${encodeURIComponent(id)}`;
}

export function smartRecruitersDetailMatches(value: unknown, expected: PostingIdentity): boolean {
  const posting = record(value);
  if (!posting || String(posting.id) !== expected.id || posting.active === false) return false;
  const company = record(posting.company)?.identifier;
  const url = typeof posting.postingUrl === 'string' ? smartRecruitersPostingIdentity(posting.postingUrl) : null;
  const board = expected.board.toLowerCase();
  if (typeof company === 'string' && company.toLowerCase() !== board) return false;
  if (posting.postingUrl && (!url || url.id !== expected.id || url.board.toLowerCase() !== board)) return false;
  return typeof company === 'string' || url !== null;
}

/** Posting API compensation is labeled by currency and period, without a base/pay split. */
export function smartRecruitersPostedCompensation(value: unknown): string | null {
  const compensation = record(record(value)?.compensation);
  if (compensation?.currency !== 'USD' || typeof compensation.period !== 'string') return null;
  const period = periods.get(compensation.period);
  if (!period) return null;
  const band = formatStructuredDollarRange(compensation.min, compensation.max);
  return band ? `${band} per ${period}` : null;
}

export function smartRecruitersPostingDescription(value: unknown): string {
  const sections = record(record(record(value)?.jobAd)?.sections);
  return ['jobDescription', 'qualifications', 'additionalInformation'].map(name => {
    const text = record(sections?.[name])?.text;
    return typeof text === 'string' ? text : '';
  }).filter(Boolean).join('\n\n');
}
