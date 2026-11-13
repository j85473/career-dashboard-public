import assert from 'node:assert/strict';
import test from 'node:test';
import { atsChoicesForJob, atsSelectionUpdate, displayAts, readLinkedInEasyApply } from '../atsDisplay';
import { identifyAts } from '../atsUtils';
import { parseLinkedInJob } from '../linkedinSearch';
import { inboxJobFilter } from '../jobListQuery';

test('requested source labels take precedence over recovered employer URLs and stored ATS metadata', () => {
  const before = { url: 'https://jobs.lever.co/acme/123', manualAts: 'Workday' };
  for (const [source, expected] of [['LinkedIn', 'LinkedIn'], ['LinkedIn (Apify) -> ATS', 'LinkedIn'],
    ['JSearch', 'JSearch'], ['Himalayas', 'Himalayas'], ['SerpApi', 'SerpAPI']]) {
    const job = { ...before, source };
    assert.equal(displayAts(job), expected);
    assert.equal(identifyAts(job), 'Workday', 'retrieval ATS remains independent of presentation');
    assert.equal(inboxJobFilter(`ats:${expected}`, 'inbox'), `ats:${expected}`);
    assert.deepEqual(before, { url: 'https://jobs.lever.co/acme/123', manualAts: 'Workday' });
  }
  assert.equal(displayAts({ source: 'ATS-workday' }), 'Workday');
  assert.equal(displayAts({ source: 'Indeed', url: before.url }), 'Lever');
});

test('only affirmative LinkedIn evidence adds Easy Apply; false and unknown remain LinkedIn', () => {
  assert.equal(displayAts({ source: 'LinkedIn', linkedinEasyApply: true }), 'LinkedIn Easy Apply');
  for (const linkedinEasyApply of [false, null, undefined]) {
    assert.equal(displayAts({ source: 'LinkedIn (Apify)', linkedinEasyApply }), 'LinkedIn');
  }
  assert.equal(displayAts({ source: 'JSearch', linkedinEasyApply: true }), 'JSearch');
  assert.equal(inboxJobFilter('ats:LinkedIn Easy Apply', 'inbox'), 'ats:LinkedIn Easy Apply');
});

test('LinkedIn and Apify structured application methods survive parsing without guessing from URLs or prose', () => {
  for (const row of [{ applyType: 'EASY_APPLY' }, { apply_type: 'Easy Apply' }, { easy_apply: true }, { isEasyApply: 'true' }]) {
    assert.equal(readLinkedInEasyApply(row), true);
    assert.equal(parseLinkedInJob({ id: 123, title: 'Account Manager', url: 'https://linkedin.com/jobs/view/123', ...row })?.linkedinEasyApply, true);
  }
  for (const row of [{ applyType: 'EXTERNAL' }, { easyApply: false }, { easy_apply: 'false' }]) {
    assert.equal(readLinkedInEasyApply(row), false);
  }
  for (const row of [{}, { applyType: 'UNKNOWN' }, { description: 'Easy Apply', applyUrl: 'https://linkedin.com/jobs/view/123' }, { easy_apply: 1 }]) {
    assert.equal(readLinkedInEasyApply(row), null);
  }
});

test('LinkedIn choice changes only application metadata and leaves saved employer ATS alone', () => {
  const job = { source: 'LinkedIn (Apify)', manualAts: 'Workday' };
  assert.deepEqual(atsChoicesForJob(job), ['LinkedIn', 'LinkedIn Easy Apply']);
  assert.deepEqual(atsSelectionUpdate(job, 'LinkedIn Easy Apply'), { linkedinEasyApply: true });
  assert.deepEqual(atsSelectionUpdate(job, 'LinkedIn'), { linkedinEasyApply: false });
  assert.deepEqual(atsChoicesForJob({ source: 'Himalayas' }), ['Himalayas']);
  assert.deepEqual(atsSelectionUpdate({ source: 'ATS-lever' }, 'Workday'), { manualAts: 'Workday' });
});
