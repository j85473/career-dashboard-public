import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverJobviteCompensation, withJobviteSalaryHeader } from '../../src/lib/jobviteCompensation';
import { parseBrowserPosting } from '../../src/lib/browserAtsPosting';
import { derivePostingFacts } from '../../src/lib/postingFacts';

const url = 'https://jobs.jobvite.com/hearthnhome/job/ojjZAfwV';
const description = 'Develop and grow relationships with assigned dealer accounts. '.repeat(20)
  + 'The posted salary range reflects a total target compensation: base + incentive.';
const header = 'Salary: USD 70500 - 83100 Annually';
const html = `<title>Hearth &amp; Home Technologies Careers - Sales Account Manager</title>
  <h2>Sales Account Manager</h2><p class="jv-job-detail-meta">Sales<span class="jv-inline-separator"></span>
  Lakeville, Minnesota<br>${header}</p>
  <a href="/hearthnhome/job/ojjZAfwV/apply">Apply</a>
  <div class="jv-job-detail-description">${description}</div>`;

test('Jobvite browser collection retains salary outside the description and preserves its meaning', () => {
  for (const page of [html, html + `<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', title: 'Sales Account Manager', description,
    hiringOrganization: { name: 'Hearth & Home Technologies' },
    // Jobvite's generic schema label must not override authored compensation terms.
    baseSalary: { currency: 'USD', value: { minValue: '70500', maxValue: '83100', unitText: 'Annually' } },
  })}</script>`]) {
    const posting = parseBrowserPosting('jobvite', 'https://jobs.jobvite.com/hearthnhome/jobs',
      { id: 'ojjZAfwV', url, title: 'Sales Account Manager' }, [{ url, html: page, text: '' }]);
    assert.ok(posting);
    assert.equal(posting.location, 'Lakeville, Minnesota');
    assert.ok(posting.description.startsWith(header));
    assert.equal(derivePostingFacts(posting.description).postedCompensation,
      '$70,500–$83,100 total target compensation (base + incentive)');
  }
});

test('salary-header recovery rejects another opening and is idempotent', () => {
  assert.equal(withJobviteSalaryHeader(html, url.replace('ojjZAfwV', 'other'), description), description);
  assert.equal(withJobviteSalaryHeader(html.replace('/ojjZAfwV/apply', '/other/apply'), url, description), description);
  const recovered = withJobviteSalaryHeader(html, url, description);
  assert.equal(withJobviteSalaryHeader(html, url, recovered), recovered);
  assert.equal(withJobviteSalaryHeader(html.replaceAll(header, 'Salary: CAD 70500 - 83100 Annually'), url, description)
    .includes('CAD'), true);
});

test('complete aggregator descriptions still receive missing compensation on new intake', async () => {
  let calls = 0;
  const read = async () => {
    calls++;
    return { ats: 'Jobvite', text: withJobviteSalaryHeader(html, url, description) };
  };
  const recovered = await recoverJobviteCompensation({ url, description }, read);
  assert.ok(recovered?.includes(header));
  assert.equal(calls, 1);
  assert.equal(await recoverJobviteCompensation({ url, description: recovered! }, read), null);
  assert.equal(await recoverJobviteCompensation({ url: 'https://example.com/jobs/1', description }, read), null);
  assert.equal(calls, 1);
  assert.equal(await recoverJobviteCompensation({ url, description }, async () => { throw new Error('503'); }), null);
  assert.equal(await recoverJobviteCompensation({ url, description }, async () => ({ ats: 'Jobvite', text: description })), null);
  assert.equal(await recoverJobviteCompensation({ url, description }, async () => ({ ats: 'Jobvite', text: recovered!, postingVerificationError: 'unverified' })), null);
});
