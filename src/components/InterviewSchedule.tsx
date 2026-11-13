'use client';

import { useState, useSyncExternalStore } from 'react';
import { CalendarDays } from 'lucide-react';
import type { JobInterviewItem, JobListItem } from '@/types/job';
import { DEFAULT_INTERVIEW_MINUTES, INTERVIEW_LABEL_MAX_LENGTH, interviewEnd, interviewIsUpcoming, interviewLocalInput, primaryInterview } from '@/lib/jobInterviewSchedule';
import { useInterviewClock } from '@/lib/useInterviewClock';
import { showConfirm } from '@/lib/modal';

const subscribeTimezone = () => () => {};
const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverTimezone = () => 'UTC';

function InterviewNotes({ text }: { text: string }) {
  return text.split(/(https?:\/\/[^\s<>"']+)/gi).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    let href = part.replace(/[.,;:!?]+$/, '');
    // Leave sentence punctuation outside the link without damaging URL parentheses.
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (href.endsWith(close) && href.split(close).length > href.split(open).length) {
        href = href.slice(0, -1);
      }
    }
    try { new URL(href); } catch { return part; }
    return <span key={index}>
      <a href={href} title={href} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}>{interviewLinkLabel(href)}</a>
      {part.slice(href.length)}
    </span>;
  });
}

function interviewLinkLabel(href: string): string {
  const host = new URL(href).hostname;
  if (host === 'mail.google.com') return 'Open confirmation email';
  if (host === 'calendar.google.com' || host === 'www.google.com' && new URL(href).pathname.startsWith('/calendar')) return 'Open calendar';
  if (host === 'teams.microsoft.com') return 'Join Teams';
  if (host === 'meet.google.com') return 'Join Google Meet';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'Join Zoom';
  if (host === 'outlook.office.com') return 'Open booking';
  return `Open ${host.replace(/^www\./, '')}`;
}

function InterviewTime({ item, timezone }: { item: JobInterviewItem; timezone: string }) {
  const end = interviewEnd(item);
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: timezone });
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: timezone });
  const endTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: timezone });
  const start = new Date(item.scheduledAt);
  return <div className="interview-time-range">
    <time dateTime={item.scheduledAt}>{date.format(start)}</time>
    <span>{time.format(start)}–{date.format(start) !== date.format(end.at) ? `${date.format(end.at)}, ` : ''}{endTime.format(end.at)}
      {end.source === 'estimated' && <span className="interview-estimate"> · estimated {DEFAULT_INTERVIEW_MINUTES} min</span>}
      {end.source === 'notes' && <span className="interview-estimate"> · end from notes</span>}
    </span>
  </div>;
}

export function InterviewSchedule({ job, onJobUpdate, compact = true }: {
  job: JobListItem;
  onJobUpdate?: (id: string, updates: Partial<JobListItem>) => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timezone = useSyncExternalStore(subscribeTimezone, browserTimezone, serverTimezone);
  const interviews = job.interviews || [];
  const now = useInterviewClock(interviews.length > 0);
  const primary = primaryInterview(interviews, now);
  const inProgress = primary && interviewIsUpcoming(primary, now) && new Date(primary.scheduledAt).getTime() <= now;

  const edit = (item?: JobInterviewItem) => {
    setEditing(item?.id || 'new');
    setDate(item ? interviewLocalInput(item.scheduledAt) : '');
    setEndDate(item ? interviewLocalInput(new Date(interviewEnd(item).at).toISOString()) : '');
    setLabel(item?.label || '');
    setError('');
  };
  const save = async (method: 'POST' | 'PATCH' | 'DELETE', id?: string) => {
    let scheduledAt: string | undefined;
    let endsAt: string | null = null;
    if (method !== 'DELETE') {
      const parsed = new Date(date);
      if (!Number.isFinite(parsed.getTime()) || interviewLocalInput(parsed.toISOString()) !== date) {
        setError('Choose a valid date and time in your timezone.');
        return;
      }
      scheduledAt = parsed.toISOString();
      if (endDate) {
        const end = new Date(endDate);
        if (!Number.isFinite(end.getTime()) || interviewLocalInput(end.toISOString()) !== endDate || end <= parsed) {
          setError('Choose an end time after the interview starts.');
          return;
        }
        endsAt = end.toISOString();
      }
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/jobs/${job.id}/interviews`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, scheduledAt, endsAt, label }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The interview could not be saved.');
      onJobUpdate?.(job.id, { interviews: data.interviews });
      setEditing(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The interview could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="interview-schedule" aria-label={`Interviews for ${job.title}`} onClick={event => event.stopPropagation()}>
      <div className="interview-schedule-heading"><CalendarDays size={15} /> Interviews
        {inProgress && <span className="interview-in-progress">In progress</span>}
      </div>
      {interviews.length === 0 && <p className="interview-schedule-empty">No interview date set</p>}
      {primary && <>
        <div className="interview-primary">
          <InterviewTime item={primary} timezone={timezone} />
          <button type="button" disabled={busy} onClick={() => edit(primary)} aria-label="Edit displayed interview">Edit</button>
        </div>
        <p className="interview-note-preview">{(primary.label || 'Interview').split(/https?:\/\//i)[0].trim() || 'Interview notes and meeting links'}</p>
        <details className="interview-details" open={compact ? undefined : true}>
          <summary>Notes &amp; interview history{interviews.length > 1 ? ` (${interviews.length} rounds)` : ''}</summary>
          {interviews.map(item => <div className="interview-schedule-round" key={item.id}>
            <div>
              <InterviewTime item={item} timezone={timezone} />
              <div className="interview-round-label"><InterviewNotes text={item.label || 'Interview'} /></div>
            </div>
            <button type="button" disabled={busy} onClick={() => edit(item)} aria-label={`Edit interview on ${new Intl.DateTimeFormat(undefined,
              { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(new Date(item.scheduledAt))}`}>Edit</button>
          </div>)}
        </details>
      </>}
      {editing === null ? (
        <button type="button" className="interview-add" disabled={busy} onClick={() => edit()}>+ Add interview date</button>
      ) : (
        <form className="interview-schedule-form" data-refresh-blocked="true" onSubmit={event => {
          event.preventDefault();
          void save(editing === 'new' ? 'POST' : 'PATCH', editing === 'new' ? undefined : editing);
        }}>
          <label>Round, interviewer, or notes (optional)
            <textarea value={label} maxLength={INTERVIEW_LABEL_MAX_LENGTH} rows={3} disabled={busy} placeholder="e.g. Hiring manager, notes, and meeting link" onChange={event => setLabel(event.target.value)} />
          </label>
          <div className="interview-form-times">
            <label>Starts
              <input type="datetime-local" required value={date} disabled={busy} onChange={event => {
                const value = event.target.value;
                const oldStart = new Date(date).getTime(), oldEnd = new Date(endDate).getTime();
                const newStart = new Date(value).getTime();
                setDate(value);
                if (Number.isFinite(newStart)) setEndDate(interviewLocalInput(new Date(newStart
                  + (oldEnd > oldStart ? oldEnd - oldStart : DEFAULT_INTERVIEW_MINUTES * 60_000)).toISOString()));
              }} />
            </label>
            <label>Ends (optional)
              <input type="datetime-local" value={endDate} min={date || undefined} disabled={busy} onChange={event => setEndDate(event.target.value)} />
            </label>
          </div>
          <span className="interview-timezone">Times shown in {timezone}</span>
          <div className="interview-form-actions">
            <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save interview'}</button>
            <button type="button" disabled={busy} onClick={() => { setEditing(null); setError(''); }}>Cancel</button>
            {editing !== 'new' && <button type="button" className="interview-remove" disabled={busy} onClick={async () => {
              if (await showConfirm('Remove this interview date from the job?', 'Remove date', 'Keep date')) void save('DELETE', editing);
            }}>Remove date</button>}
          </div>
        </form>
      )}
      {error && <p role="alert" className="interview-schedule-error">{error}</p>}
    </section>
  );
}
