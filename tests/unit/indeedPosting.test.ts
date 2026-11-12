import assert from 'node:assert/strict';
import test from 'node:test';
import { indeedPostingKey, indeedPostingUrl } from '../../src/lib/indeedPostingUrl';
import { fetchIndeedPosting, parseIndeedDetail, parseIndeedPostingHtml } from '../../src/lib/indeedPosting';
import { urlPostingIdentity } from '../../src/lib/jobUrlReconciliation';

const key = '27d68cc76167ad0a';
const url = `https://www.indeed.com/viewjob?jk=${key}`;
const text = 'Responsibilities: Manage an assigned sales territory, build account relationships, develop account plans and support customers. Qualifications: Three years of field sales experience, strong communication and organization skills, and ability to travel throughout the territory. '.repeat(5);
const detail = { id: key, title: 'Territory Sales Representative', company_name: 'Example Employer', location: 'Minneapolis, MN', description: `<p>${text}</p>` };
const posting = { '@type': 'JobPosting', url, title: detail.title, hiringOrganization: { name: detail.company_name },
  jobLocation: { address: { addressLocality: 'Minneapolis', addressRegion: 'MN' } }, description: detail.description };
const page = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

test('Indeed selected posting keys match tracked, mobile, search and slug links without merging different openings', () => {
  const aliases = [url, `${url}&advn=4274197825445369&dest=http%3A%2F%2Fwww.indeed.com%2Fjob%2Fterritory-sales-representative-minneapolis-minnesota-${key}`,
    `https://www.indeed.com/jobs?q=sales&vjk=${key}`, `https://www.indeed.com/m/viewjob?jk=${key.toUpperCase()}`,
    `https://www.indeed.com/rc/clk?jk=${key}`, `https://www.indeed.com/job/territory-sales-representative-minneapolis-minnesota-${key}`];
  for (const alias of aliases) {
    assert.equal(indeedPostingKey(alias), key);
    assert.equal(indeedPostingUrl(alias), url);
    assert.equal(urlPostingIdentity(alias), urlPostingIdentity(url));
  }
  assert.equal(indeedPostingKey(`https://ca.indeed.com/viewjob?jk=${key}`), key);
  assert.notEqual(urlPostingIdentity(url), urlPostingIdentity(url.replace(key, '1111111111111111')));
  for (const invalid of ['https://www.indeed.com/jobs?q=sales', `${url}&jk=1111111111111111`,
    'https://www.indeed.com/viewjob?jk=bad', `https://indeed.com.evil.test/viewjob?jk=${key}`, `https://evil.test/?jk=${key}`]) {
    assert.equal(indeedPostingKey(invalid), null);
    assert.equal(indeedPostingUrl(invalid), null);
  }
});

test('Indeed detail lookup accepts authored details and rejects mismatched IDs, snippets and placeholder metadata', () => {
  const result = parseIndeedDetail(detail, url)!;
  assert.equal(result.title, detail.title);
  assert.equal(result.company, detail.company_name);
  assert.equal(result.location, detail.location);
  assert.equal(result.text, text.trim());
  assert.equal(result.postingUrl, url);
  assert.equal(parseIndeedDetail({ ...detail, id: '1111111111111111' }, url), null);
  assert.equal(parseIndeedDetail({ ...detail, url: url.replace(key, '1111111111111111') }, url), null);
  assert.equal(parseIndeedDetail({ ...detail, description: 'A short search snippet.' }, url), null);
  assert.equal(parseIndeedDetail({ ...detail, title: 'Viewjob' }, url), null);
  assert.equal(parseIndeedDetail({ ...detail, company_name: 'Indeed' }, url), null);
});

test('Indeed HTML selects the requested posting from JSON-LD graphs and ignores sibling recommendations', () => {
  const other = { ...posting, url: url.replace(key, '1111111111111111'), title: 'Different job' };
  assert.equal(parseIndeedPostingHtml(page({ '@graph': [other, posting] }), url)?.title, detail.title);
  assert.equal(parseIndeedPostingHtml(page(other), url), null);
  assert.equal(parseIndeedPostingHtml(`<link rel="canonical" href="${other.url}">${page(posting)}`, url), null);
  assert.equal(parseIndeedPostingHtml(`<title>Sign In | Indeed Accounts</title><form>${text}</form>`, url), null);
  assert.equal(parseIndeedPostingHtml('<title>Authenticating...</title><body>Redirecting to login...</body>', url), null);
});

test('Indeed job-view DOM extraction reads the description container and excludes unrelated page text', () => {
  const html = `<h1 data-testid="jobsearch-JobInfoHeader-title">${detail.title}</h1><span data-testid="inlineHeader-companyName">${detail.company_name}</span>
    <div data-testid="job-location">${detail.location}</div><div id="jobDescriptionText">${detail.description}</div><footer>Recommended jobs ${text}</footer>`;
  assert.equal(parseIndeedPostingHtml(html, url)?.text, text.trim());
});

test('Indeed uses a readable public page without spending an API request', async () => {
  const result = await fetchIndeedPosting(url, { readPage: async target => ({ url: target, html: page(posting) }),
    readDetail: async () => assert.fail('Public posting already supplied complete evidence') });
  assert.equal(result.title, detail.title);
});

test('a blocked or redirected Indeed page falls back to the exact job-key API, regardless of import source', async () => {
  for (const readPage of [async () => null, async () => ({ url: 'https://secure.indeed.com/auth', html: page(posting) }),
    async () => { throw new Error('HTTP 403'); }]) {
    const result = await fetchIndeedPosting(url, { readPage, readDetail: async requested => { assert.equal(requested, key); return detail; } });
    assert.equal(result.title, detail.title);
  }
});

test('blocked Indeed access and exhausted API budgets require pasted details without claiming closure', async () => {
  const result = await fetchIndeedPosting(url, { readPage: async () => null,
    readDetail: async () => { throw new Error('Indeed Details request blocked by paced_budget'); } });
  assert.equal(result.text, '');
  assert.match(result.postingVerificationError!, /sign-in|blocking automated access/);
  assert.match(result.postingVerificationError!, /No job was imported/);
});
