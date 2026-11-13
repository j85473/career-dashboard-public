'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { JobListItem } from '@/types/job';
import { compareInterviewJobs, interviewSortKey, partitionInterviewJobs } from '@/lib/jobInterviewSchedule';
import { useInterviewClock } from '@/lib/useInterviewClock';

export function InterviewJobSections({ jobs, sort, renderJobs, onTimeBoundary }: {
  jobs: JobListItem[];
  sort: string;
  renderJobs: (jobs: JobListItem[]) => ReactNode;
  onTimeBoundary?: () => void;
}) {
  const now = useInterviewClock();
  const previousNow = useRef(now);
  useEffect(() => {
    const before = previousNow.current;
    previousNow.current = now;
    if (jobs.some(job => interviewSortKey(job, before).join(':') !== interviewSortKey(job, now).join(':'))) onTimeBoundary?.();
  }, [jobs, now, onTimeBoundary]);
  const ordered = sort === 'interview_time' ? [...jobs].sort((a, b) => compareInterviewJobs(a, b, now)) : jobs;
  const groups = partitionInterviewJobs(ordered, now);
  return <div className="interview-sections">
    {([
      ['upcoming', 'Upcoming & in progress'],
      ['past', 'Past interviews'],
      ['undated', 'No interview date'],
    ] as const).map(([key, heading]) => (key === 'upcoming' || groups[key].length > 0) && (
      <section className={`interview-job-section interview-job-section-${key}`} key={key} aria-labelledby={`interview-${key}-heading`}>
        <div className="interview-section-divider">
          <h2 id={`interview-${key}-heading`}>{heading}</h2>
          <span>{groups[key].length}</span>
        </div>
        {groups[key].length ? renderJobs(groups[key]) : <p className="interview-section-empty">No upcoming interviews scheduled.</p>}
      </section>
    ))}
  </div>;
}
