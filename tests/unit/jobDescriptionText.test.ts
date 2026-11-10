import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanJobDescriptionText } from '../../src/lib/jobDescriptionText';
import { postingRefreshDescription } from '../../src/lib/postingMetadata';
import { presentJobDescription } from '../../src/lib/jobDescriptionPresentation';
import { isClosedJobPosting } from '../../src/lib/jobDescriptionQuality';

const url = 'https://careers.example.com/job/Shoreview-Account-Manager/1444273000/';
const apply = `[Apply now »](${url.replace(/job\/.*$/, 'talentcommunity/apply/1444273000/?locale=en_US')})`;
const duties = 'Manage customer accounts, support partner planning and coordinate sales programs. '.repeat(10).trim();
const body = `Location: Shoreview, MN, US\n\n**Responsibilities**\n${duties}\n\n**Requirements**\n* Minimum 8-10 years of semiconductor experience.\n* Travel (~40%) across the USA.\n\n**Pay & Benefits**\n$115,000-$150,000 per year. Health insurance, 401(k), paid time off.\n\nLegal authorization to work in the United States without sponsorship.\nEOE/Vet/Disability\n[Request accommodation](mailto:access@example.com)`;
const envelope = (content: string, source = url) => `Title: Account Manager\n\nURL Source: ${source}\n\nMarkdown Content:\n${content}`;
const page = envelope(`[Skip to main content](${url}#content)\n[Candidate Login](${url}#)\n[![Image 1: Employer](https://rmkcdn.successfactors.com/a/logo.jpg)](https://example.com/)\nSearch by Keyword\nLoading...\n${apply}\n\n# Account Manager\n\n${body}\n\n**Nearest Major Market:**Minneapolis\n**Job Segment:**Sales\n\n${apply}\n\nFind similar jobs:\n[Other role](https://careers.example.com/jobs/other)\n[Facebook](https://facebook.com/company)`);

test('a branded SAP reader page keeps every posting paragraph and removes page furniture', () => {
  assert.equal(cleanJobDescriptionText(page), body);
  assert.equal(cleanJobDescriptionText(cleanJobDescriptionText(page)), body);
  const refreshed = postingRefreshDescription({ description: page, structuredSource: false,
    existingDescription: '', preserveScores: true, metadata: {} });
  assert.deepEqual(refreshed, { description: body, verified: true });
});

test('historical presentation cleans the JD without mutating scores, history or the saved text', () => {
  const job = Object.freeze({ description: page, status: 'applied', aimFitScore: 82, reqFitScore: 85,
    scoreHistory: Object.freeze([{ id: 'existing-score' }]) });
  assert.deepEqual(presentJobDescription(job), { ...job, description: body });
  assert.equal(job.description, page);
});

test('unknown layouts keep their prose; reader images and envelopes do not reach the JD', () => {
  const prose = 'Responsibilities: See the following example.\n\nRequirements: 5+ years.\n![Image 2: Must lift 50 lbs](https://images.example.com/requirements.png)\n[Accommodation](mailto:access@example.com)';
  const cleaned = cleanJobDescriptionText(envelope(`[![Image 1: Company Logo](https://images.example.com/logo_(large).png)](https://example.com/)\n\n${prose}`));
  assert.equal(cleaned, prose.replace(/!\[Image 2: Must lift 50 lbs\]\([^\n]+\)/, 'Must lift 50 lbs'));
  assert.doesNotMatch(cleaned, /Title:|URL Source:|Markdown Content:|Image \d|images\.example/);
  assert.equal(cleanJobDescriptionText(body), body, 'authored Markdown bypasses reader cleanup');
  assert.equal(cleanJobDescriptionText(envelope('![Image 3: Must have logo design experience](https://images.example.com/requirements.png)')),
    'Must have logo design experience', 'a job requirement mentioning imagery is still evidence');
});

test('SAP page cropping requires a matching title, exact apply ID and vendor evidence', () => {
  for (const broken of [
    page.replace('Title: Account Manager', 'Title: Another Role'),
    page.replaceAll('/apply/1444273000/', '/apply/999/'),
    page.replace('rmkcdn.successfactors.com', 'images.example.com'),
  ]) {
    const cleaned = cleanJobDescriptionText(broken);
    assert.ok(cleaned.includes(body));
    assert.match(cleaned, /Search by Keyword/);
    assert.match(cleaned, /Find similar jobs/);
  }
});

test('reader failure evidence survives cleanup and cannot turn missing pages into live jobs', () => {
  const missing = envelope('This job is no longer available.').replace('Markdown Content:',
    'Warning: Target URL returned error 404: Not Found\n\nMarkdown Content:');
  const cleaned = cleanJobDescriptionText(missing);
  assert.match(cleaned, /^Warning: Target URL returned error 404/);
  assert.equal(isClosedJobPosting(cleaned), true);
  assert.equal(cleanJobDescriptionText(cleaned), cleaned);
});

test('navigation and image URLs cannot inflate a short SAP posting past the quality gate', () => {
  const short = page.replace(body, 'Responsibilities: Manage accounts. Requirements: Sales experience.');
  assert.throws(() => postingRefreshDescription({ description: short, structuredSource: false,
    existingDescription: '', preserveScores: false, metadata: {} }), /verifiable job description/);
});
