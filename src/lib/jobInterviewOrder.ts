import type { Prisma, PrismaClient } from './prismaClient';
import { prisma } from './prisma';
import { compareInterviewJobs } from './jobInterviewSchedule';
import { interviewSortKey } from './jobInterviewSchedule';
import { jobOrder } from './jobListQuery';

export const jobInterviewSelect = { id: true, scheduledAt: true, endsAt: true, label: true } as const;
export const jobInterviewsSelect = {
  select: jobInterviewSelect,
  orderBy: [{ scheduledAt: 'asc' as const }, { id: 'asc' as const }],
};

/** The small interview log is ordered across all matching cards before pagination. */
export async function interviewOrderedPage(
  where: Prisma.JobWhereInput,
  limit: number,
  offset: number,
  client: Pick<PrismaClient, 'job'> = prisma,
  now = Date.now(),
  sort = 'interview_time',
) {
  const jobs = await client.job.findMany({ where, select: { id: true, interviews: jobInterviewsSelect },
    orderBy: jobOrder('interviewing', sort) });
  jobs.sort((a, b) => sort === 'interview_time' ? compareInterviewJobs(a, b, now)
    : interviewSortKey(a, now)[0] - interviewSortKey(b, now)[0]);
  return { ids: jobs.slice(offset, offset + limit).map(job => job.id), total: jobs.length };
}
