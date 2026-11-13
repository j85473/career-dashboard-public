import assert from 'node:assert/strict';
import test from 'node:test';
import { compareInterviewJobs, parseInterviewInput, interviewLocalInput, INTERVIEW_LABEL_MAX_LENGTH, interviewEnd, interviewSortKey, partitionInterviewJobs } from '../jobInterviewSchedule';
import { interviewOrderedPage } from '../jobInterviewOrder';
import { defaultJobSort } from '../jobSort';

const now = Date.parse('2026-11-04T15:00:00Z');
const round = (scheduledAt: string) => ({ id: scheduledAt, scheduledAt: new Date(scheduledAt), label: '' });
const jobs = [
  { id: 'undated', interviews: [] },
  { id: 'past-old', interviews: [round('2026-10-01T14:00:00Z')] },
  { id: 'next-later', interviews: [round('2026-11-06T14:00:00Z')] },
  { id: 'multiple-rounds', interviews: [round('2026-11-01T14:00:00Z'), round('2026-11-05T14:00:00Z')] },
  { id: 'past-recent', interviews: [round('2026-11-03T14:00:00Z')] },
  { id: 'right-now', interviews: [round('2026-11-04T15:00:00Z')] },
];

test('the interview log defaults to interview time and keeps next rounds ahead of past or undated cards', () => {
  assert.equal(defaultJobSort('interviewing'), 'interview_time');
  assert.deepEqual([...jobs].sort((a, b) => compareInterviewJobs(a, b, now)).map(job => job.id),
    ['right-now', 'multiple-rounds', 'next-later', 'past-recent', 'past-old', 'undated']);
  assert.equal(compareInterviewJobs({ id: 'a' }, { id: 'b' }, now) < 0, true);
});

test('interview ordering is applied before page boundaries and retains the search predicate', async () => {
  const where = { status: 'interviewing', company: 'Exact employer' };
  const client = { job: { findMany: async (query: { where: unknown }) => {
    assert.deepEqual(query.where, where);
    return [...jobs];
  } } } as unknown as Parameters<typeof interviewOrderedPage>[3];
  assert.deepEqual(await interviewOrderedPage(where, 2, 2, client, now), {
    ids: ['next-later', 'past-recent'], total: 6,
  });
  assert.deepEqual(await interviewOrderedPage(where, 2, 6, client, now), { ids: [], total: 6 });
});

test('interview input requires an absolute time and accepts notes with long meeting links', () => {
  const parsed = parseInterviewInput({ scheduledAt: '2026-11-04T09:00:00-06:00', label: '  Recruiter  ' });
  assert.equal(parsed.scheduledAt.toISOString(), '2026-11-04T15:00:00.000Z');
  assert.equal(parsed.label, 'Recruiter');
  const notes = `Hiring manager\nhttps://teams.microsoft.com/l/meetup-join/${'a'.repeat(500)}?context=test`;
  assert.equal(parseInterviewInput({ scheduledAt: '2026-11-04T15:00:00Z', label: notes }).label, notes);
  for (const body of [null, {}, { scheduledAt: '2026-11-04T09:00' }, { scheduledAt: 'nonsense' },
    { scheduledAt: '2026-02-30T15:00:00Z' }, { scheduledAt: '2026-11-04T24:00:00Z' },
    { scheduledAt: '2026-11-04T15:00:00Z', label: 'x'.repeat(INTERVIEW_LABEL_MAX_LENGTH + 1) }]) {
    assert.throws(() => parseInterviewInput(body));
  }
  const local = new Date(2026, 10, 4, 9, 30);
  assert.equal(interviewLocalInput(local.toISOString()), '2026-11-04T09:30');
});

test('a 9:30–10:00 interview stays first through its end minute and moves at 10:01', () => {
  const current = { id: 'current', interviews: [{ scheduledAt: '2026-11-13T15:30:00Z', endsAt: '2026-11-13T16:00:00Z' }] };
  const next = { id: 'next', interviews: [round('2026-11-13T16:30:00Z')] };
  for (const at of ['2026-11-13T15:31:00Z', '2026-11-13T16:00:00Z', '2026-11-13T16:00:59.999Z']) {
    const clock = Date.parse(at);
    assert.equal(interviewSortKey(current, clock)[0], 0, at);
    assert.deepEqual([next, current].sort((a, b) => compareInterviewJobs(a, b, clock)).map(job => job.id), ['current', 'next']);
  }
  const groups = partitionInterviewJobs([next, current, { id: 'undated', interviews: [] }], Date.parse('2026-11-13T16:01:00Z'));
  assert.deepEqual(groups.upcoming.map(job => job.id), ['next']);
  assert.deepEqual(groups.past.map(job => job.id), ['current']);
  assert.deepEqual(groups.undated.map(job => job.id), ['undated']);
});

test('older notes retain an interview through its stated duration, while missing duration is estimated', () => {
  const scheduledAt = '2026-11-13T15:30:00Z';
  for (const label of ['Duration: 30 minutes.', '9:30–10:00 AM CST (10:30–11:00 AM EST)', '9:30 a.m.–10:00 a.m. Central']) {
    assert.deepEqual(interviewEnd({ scheduledAt, label }), { at: Date.parse('2026-11-13T16:00:00Z'), source: 'notes' });
  }
  assert.deepEqual(interviewEnd({ scheduledAt, label: 'expected 15–20 minutes' }), { at: Date.parse('2026-11-13T15:50:00Z'), source: 'notes' });
  assert.deepEqual(interviewEnd({ scheduledAt, label: '1.5 hours' }), { at: Date.parse('2026-11-13T17:00:00Z'), source: 'notes' });
  assert.deepEqual(interviewEnd({ scheduledAt, label: '60-minute interview' }), { at: Date.parse('2026-11-13T16:30:00Z'), source: 'notes' });
  assert.equal(interviewEnd({ scheduledAt, label: 'Hiring manager' }).source, 'estimated');
  assert.equal(interviewEnd({ scheduledAt, endsAt: '2026-11-13T16:15:00Z', label: 'Duration: 30 minutes' }).at, Date.parse('2026-11-13T16:15:00Z'));
  const multiround = { id: 'multiple', interviews: [{ scheduledAt, label: '30 minutes' }, round('2026-11-14T15:00:00Z')] };
  assert.equal(interviewSortKey(multiround, Date.parse('2026-11-13T15:45:00Z'))[1], Date.parse(scheduledAt));
  assert.equal(interviewSortKey(multiround, Date.parse('2026-11-13T16:01:00Z'))[1], Date.parse('2026-11-14T15:00:00Z'));
  assert.deepEqual(interviewSortKey({ id: 'invalid', interviews: [round('invalid')] }, now), [2, 0]);
});

test('end times accept timezone offsets, reject reversed/invalid slots, and preserve omission for older clients', () => {
  const scheduledAt = '2026-11-13T09:30:00-06:00';
  assert.equal(parseInterviewInput({ scheduledAt, endsAt: '2026-11-13T10:00:00-06:00' }).endsAt?.toISOString(), '2026-11-13T16:00:00.000Z');
  assert.equal('endsAt' in parseInterviewInput({ scheduledAt }), false);
  assert.equal(parseInterviewInput({ scheduledAt, endsAt: null }).endsAt, null);
  for (const endsAt of [scheduledAt, '2026-11-13T09:29:00-06:00', '2026-02-30T10:00:00Z', '2026-11-13T10:00', 'bad']) {
    assert.throws(() => parseInterviewInput({ scheduledAt, endsAt }));
  }
});

test('alternate interview sorts still group upcoming ahead of past before pagination', async () => {
  const client = { job: { findMany: async (query: { orderBy: unknown }) => {
    assert.deepEqual(query.orderBy, [{ createdAt: 'desc' }, { id: 'asc' }]);
    return [jobs[1], jobs[2], jobs[4], jobs[5], jobs[0]];
  } } } as unknown as Parameters<typeof interviewOrderedPage>[3];
  assert.deepEqual(await interviewOrderedPage({ status: 'interviewing' }, 2, 0, client, now, 'newest'), {
    ids: ['next-later', 'right-now'], total: 5,
  });
});
