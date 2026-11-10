import assert from 'node:assert/strict';
import test from 'node:test';
import { clearCompanyEmailPostingUrl } from '../../src/lib/clearcompanyBoard';
import { parseTenantAtsListing } from '../../src/lib/tenantAtsBoards';

const site = '11111111-1111-1111-1111-111111111111';
const peerId = '22222222-2222-2222-2222-222222222222';
const emailId = '33333333-3333-3333-3333-333333333333';
const email = '123456@exampleemployer.apply.clrco.com';
const peer = { id: peerId, applyLink: `https://exampleemployer.clearcompany.com/careers/jobs/${peerId}/apply` };

test('a vendor email application retains its source channel and exact posting identity on the canonical public page', () => {
  const common = { positionTitle: 'Service Technician', description: 'Maintain customer equipment and coordinate service visits.', brandName: 'Example Employer', location: 'Maumee, OH' };
  const payload = { currentPageIndex: 0, totalCount: 2, results: [
    { ...common, ...peer }, { ...common, id: emailId, applyLink: email },
  ] };
  const original = JSON.stringify(payload);
  const result = parseTenantAtsListing('clearcompany', site, payload, null);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs[1].id, `${site}::${emailId}`);
  assert.equal(result.jobs[1].publicAtsPostingId, emailId);
  assert.equal(result.jobs[1].url, `https://apply.clearcompany.com/exampleemployer?jobId=${emailId}`);
  assert.equal(result.jobs[1].clearcompanyApplyLink, email);
  assert.equal(result.jobs[1].description, common.description);
  assert.equal(result.jobs[1].company, common.brandName);
  assert.equal(result.jobs[1].location, common.location);
  assert.equal(result.metadata.listingHasMore, false);
  assert.equal(JSON.stringify(payload), original);
});

test('email fallback also accepts the same exact-ID public hosted-page evidence', () => {
  assert.equal(clearCompanyEmailPostingUrl(`mailto:${email}`, emailId.toUpperCase(), [
    { id: peerId, applyLink: `https://apply.clearcompany.com/exampleemployer?jobId=${peerId}` },
  ]), `https://apply.clearcompany.com/exampleemployer?jobId=${emailId}`);
});

test('email fallback requires one corroborated tenant and matching peer posting IDs', () => {
  for (const postings of [[], [{ ...peer, applyLink: peer.applyLink.replace(peerId, emailId) }],
    [{ ...peer, applyLink: peer.applyLink.replace('exampleemployer.', 'otheremployer.') }],
    [peer, { ...peer, applyLink: peer.applyLink.replace('exampleemployer.', 'otheremployer.') }],
    [{ ...peer, applyLink: peer.applyLink.replace('https://', 'http://') }],
    [{ ...peer, applyLink: peer.applyLink.replace('https://', 'https://user@') }],
    [{ ...peer, applyLink: peer.applyLink.replace('.com/', '.com:444/') }]]) {
    assert.throws(() => clearCompanyEmailPostingUrl(email, emailId, postings), /lacks corroborating posting links/);
  }
});

test('ordinary links and arbitrary email channels do not acquire a fallback', () => {
  for (const value of [peer.applyLink, 'person@example.com', 'person@exampleemployer.apply.clrco.com',
    '123@exampleemployer.apply.clrco.com.evil.example', `${email}?subject=apply`]) {
    assert.equal(clearCompanyEmailPostingUrl(value, emailId, [peer]), null);
  }
  assert.equal(clearCompanyEmailPostingUrl(email, '../invalid', [peer]), null);
  assert.throws(() => clearCompanyEmailPostingUrl('123@support.apply.clrco.com', emailId, [peer]), /reserved tenant/);
});
