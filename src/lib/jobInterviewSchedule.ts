export type ScheduledInterview = { scheduledAt: string | Date; endsAt?: string | Date | null; label?: string | null };
type InterviewJob = { id: string; interviews?: readonly ScheduledInterview[] };

export const INTERVIEW_LABEL_MAX_LENGTH = 4000;
export const DEFAULT_INTERVIEW_MINUTES = 30;

/** Older entries keep their notes intact; explicit saved end times take precedence. */
export function interviewEnd(item: ScheduledInterview): { at: number; source: 'scheduled' | 'notes' | 'estimated' } {
  const start = new Date(item.scheduledAt).getTime();
  const savedEnd = item.endsAt ? new Date(item.endsAt).getTime() : NaN;
  if (Number.isFinite(savedEnd) && savedEnd > start) return { at: savedEnd, source: 'scheduled' };
  const notes = item.label || '';
  const durations = [...notes.matchAll(/\b(\d{1,3}(?:\.\d+)?)(?:\s*[-–—]\s*(\d{1,3}(?:\.\d+)?))?\s*[-–—]?\s*(minutes?|mins?|hours?|hrs?)\b/gi)]
    .map(match => Number(match[2] || match[1]) * (/^(?:h)/i.test(match[3]) ? 60 : 1));
  const ranges = notes.matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/gi);
  for (const match of ranges) {
    const [startHour, startMinute, endHour, endMinute] = [match[1], match[2], match[4], match[5]].map(Number);
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) continue;
    const clock = (hour: number, minute: number, period?: string) => period
      ? (hour % 12 + (/^p/i.test(period) ? 12 : 0)) * 60 + minute : hour * 60 + minute;
    let duration = clock(endHour, endMinute, match[6] || match[3]) - clock(startHour, startMinute, match[3] || match[6]);
    if (duration <= 0) duration += startHour <= 12 && endHour <= 12 && !(match[3] && match[6]) ? 720 : 1440;
    durations.push(duration);
  }
  const usable = durations.filter(minutes => minutes > 0 && minutes <= 720);
  const minutes = usable.length ? Math.max(...usable) : DEFAULT_INTERVIEW_MINUTES;
  return { at: start + minutes * 60_000, source: usable.length ? 'notes' : 'estimated' };
}

/** Keep the entire displayed end minute: a 10:00 end moves to past at 10:01. */
export function interviewIsUpcoming(item: ScheduledInterview, now: number): boolean {
  const end = interviewEnd(item).at;
  return Number.isFinite(end) && now < Math.floor(end / 60_000) * 60_000 + 60_000;
}

export function primaryInterview<T extends ScheduledInterview>(interviews: readonly T[], now: number): T | undefined {
  const valid = interviews.filter(item => Number.isFinite(new Date(item.scheduledAt).getTime()));
  const upcoming = valid.filter(item => interviewIsUpcoming(item, now));
  return upcoming.length ? upcoming.reduce((first, item) => new Date(item.scheduledAt) < new Date(first.scheduledAt) ? item : first)
    : valid.reduce<T | undefined>((last, item) => !last || new Date(item.scheduledAt) > new Date(last.scheduledAt) ? item : last, undefined);
}

export function partitionInterviewJobs<T extends InterviewJob>(jobs: readonly T[], now: number): { upcoming: T[]; past: T[]; undated: T[] } {
  const groups: { upcoming: T[]; past: T[]; undated: T[] } = { upcoming: [], past: [], undated: [] };
  for (const job of jobs) groups[(['upcoming', 'past', 'undated'] as const)[interviewSortKey(job, now)[0]]].push(job);
  return groups;
}

/** In-progress/next round, or the most recent past round when none remain. */
export function interviewSortKey(job: InterviewJob, now: number): [number, number] {
  const interview = primaryInterview(job.interviews || [], now);
  if (!interview) return [2, 0];
  const start = new Date(interview.scheduledAt).getTime();
  return interviewIsUpcoming(interview, now) ? [0, start] : [1, -start];
}

export function compareInterviewJobs(a: InterviewJob, b: InterviewJob, now: number): number {
  const left = interviewSortKey(a, now);
  const right = interviewSortKey(b, now);
  return left[0] - right[0] || left[1] - right[1] || a.id.localeCompare(b.id);
}

export function parseInterviewInput(body: unknown): { scheduledAt: Date; endsAt?: Date | null; label: string } {
  if (!body || typeof body !== 'object') throw new Error('Enter an interview date and time.');
  const { scheduledAt, endsAt, label = '' } = body as Record<string, unknown>;
  const start = parseAbsoluteInterviewDate(scheduledAt);
  const end = endsAt === undefined ? undefined : endsAt === null || endsAt === '' ? null : parseAbsoluteInterviewDate(endsAt);
  if (end && end <= start) throw new Error('The interview end time must be after its start time.');
  if (typeof label !== 'string' || label.trim().length > INTERVIEW_LABEL_MAX_LENGTH) {
    throw new Error('Keep the interview notes to 4,000 characters or fewer.');
  }
  return { scheduledAt: start, ...(end !== undefined ? { endsAt: end } : {}), label: label.trim() };
}

function parseAbsoluteInterviewDate(scheduledAt: unknown): Date {
  // Require an absolute instant so a server timezone cannot shift the interview.
  if (typeof scheduledAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledAt)
    || !Number.isFinite(Date.parse(scheduledAt))) {
    throw new Error('Enter a valid interview date and time with a timezone.');
  }
  const [year, month, day] = scheduledAt.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day || Number(scheduledAt.slice(11, 13)) > 23) {
    throw new Error('Enter a valid interview date and time with a timezone.');
  }
  return new Date(scheduledAt);
}

/** datetime-local controls use the viewer's timezone, including its date-specific DST offset. */
export function interviewLocalInput(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
