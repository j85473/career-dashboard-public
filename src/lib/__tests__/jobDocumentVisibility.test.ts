import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobDocuments } from '../../components/JobDocuments';
import type { JobListItem } from '../../types/job';

const base = { id: 'job', title: 'Account Manager', company: 'Employer', status: 'applied' };
const render = (updates: Partial<JobListItem> = {}) => renderToStaticMarkup(React.createElement(JobDocuments, {
  job: { ...base, ...updates },
}));
const uploads = ['Attach JD', 'Attach prep pack', 'Attach transcripts'];

test('attachment options are absent until a job enters Interviewing', () => {
  for (const status of ['inbox', 'applied', 'bookmarked', 'passed', 'expired']) {
    assert.equal(render({ status, hasInterviewHistory: false }), '');
  }
  const html = render({ status: 'interviewing' });
  for (const label of uploads) assert.ok(html.includes(label));
});

test('all upload options remain after leaving Interviewing, even with no saved documents', () => {
  for (const status of ['applied', 'inbox', 'bookmarked', 'passed', 'expired']) {
    const html = render({ status, hasInterviewHistory: true, attachments: [] });
    for (const label of uploads) assert.ok(html.includes(label), `${status}: ${label}`);
    assert.doesNotMatch(html, /Capture JD from source/);
  }
});

test('existing prep packs, JDs and transcripts remain visible even on legacy cards without recorded interview history', () => {
  const attachments = (['prep', 'jd', 'transcript'] as const).map(kind => ({
    id: kind, kind, fileName: `${kind}.txt`, mimeType: 'text/plain', sizeBytes: 20, uploadedAt: '2026-11-13T18:00:00Z',
  }));
  const before = structuredClone(attachments);
  const html = render({ attachments, hasInterviewHistory: false });
  for (const attachment of attachments) assert.ok(html.includes(`/attachments/${attachment.id}`));
  for (const label of uploads) assert.ok(!html.includes(label));
  assert.deepEqual(attachments, before);
});
