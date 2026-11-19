import assert from 'node:assert/strict';
import test from 'node:test';

import { matchJobLeadsReprints, readJobLeadsReprint, type JobLeadsPosting } from '../jobLeadsReprint';

const DUTIES = [
  'Grow the services portfolio with regional partners Atlas, Alpine, Redwood, & Summit.',
  'Build a partner training program with field sales and delivery teams.',
  'Increase service attach rates with resellers in the commercial segment.',
  'Track joint pipeline opportunities and review them with partner managers.',
  'Identify opportunities to include long term support in customer proposals.',
  'Build recurring revenue through national promotions and enterprise subscription offerings.',
];

function posting(input: {
  title?: string; geography?: string; workMode?: string; id?: string; summary?: string;
  requisition?: string; duties?: string[]; pay?: string;
} = {}): JobLeadsPosting {
  const title = input.title || 'Remote Services Channel Manager - Large VARs';
  const company = 'Acme Inc.';
  const url = `https://www.jobleads.com/us/job/services-channel-manager--${input.id || 'a'.repeat(32)}`;
  const description = [
    'Job Search and Career Advice Platform',
    `# ${title}`,
    `## ${company}`,
    `## ${input.geography || 'Morrisville (NC)'}`,
    `## ${input.workMode || 'Remote'}`,
    `## USD ${input.pay || '120,000 - 180,000'}`,
    '### Job summary',
    input.summary || 'This role helps national partners adopt new services.',
    input.requisition ? `Req # ${input.requisition}` : '',
    '### Responsibilities',
    (input.duties || DUTIES).map(duty => `* ${duty}`).join('\n'),
    '## Job description',
    'Similar jobs',
    '# Similar jobs worth comparing',
    'Different jobs or text below the active posting.',
  ].join('\n\n');
  return { source: 'JSearch', title, company, employer: 'Acme', location: 'Unknown Location', url,
    canonicalUrl: url, userCanonicalUrl: null, description, postedAt: new Date('2026-11-11T00:00:00Z') };
}

function match(left: JobLeadsPosting, right: JobLeadsPosting) {
  const a = readJobLeadsReprint(left);
  const b = readJobLeadsReprint(right);
  assert.ok(a && b, 'both primary postings must be readable');
  return matchJobLeadsReprints(a, b);
}

test('rewritten JSearch copies agree on the responsibilities of the primary JobLeads posting', () => {
  const first = posting();
  const second = posting({
    id: 'b'.repeat(32), geography: 'North Carolina', title: 'Remote Services Channel Manager — Large VARs',
    summary: 'A home-based sales role responsible for expanding subscriptions through strategic resellers.',
    pay: '100,000 - 140,000', duties: [DUTIES[0].replace(', & Summit', ', Summit'), ...DUTIES.slice(1)],
  });
  const third = posting({ id: 'c'.repeat(32), title: 'Remote Services Channel Manager – Large VAR Partners' });
  for (const [a, b] of [[first, second], [first, third], [second, third]]) {
    assert.equal(match(a, b)?.rule, 'jobleads_responsibilities');
  }
});

test('same duty template cannot override distinct titles, work modes, territories, requisitions, or time windows', () => {
  const first = posting({ requisition: 'WD0012345' });
  const different = [
    posting({ title: 'Remote Senior Services Channel Manager - Large VARs' }),
    posting({ geography: 'Charlotte (NC)' }),
    posting({ workMode: 'Hybrid' }),
    posting({ requisition: 'WD0012346' }),
    { ...posting(), postedAt: new Date('2026-10-01T00:00:00Z') },
    { ...posting({ geography: 'North Carolina' }), location: 'Charlotte, NC' },
    posting({ duties: [...DUTIES.slice(0, 5), 'Build recurring revenue from small businesses instead of enterprise accounts.'] }),
  ];
  for (const other of different) assert.equal(match(first, other), null);
});

test('only primary posting text from unresolved JSearch JobLeads links supplies evidence', () => {
  const valid = posting();
  for (const input of [
    { ...valid, canonicalUrl: 'https://jobs.acme.com/job/123456' },
    { ...valid, userCanonicalUrl: valid.url },
    { ...valid, source: 'Indeed' },
    { ...valid, description: valid.description!.replace('### Responsibilities', '## Similar jobs\n\n### Responsibilities') },
    { ...valid, description: 'Short JSearch result with only the title and employer' },
    { ...valid, title: 'Wrong title' },
    posting({ duties: DUTIES.slice(0, 4) }),
  ]) assert.equal(readJobLeadsReprint(input), null);
});
