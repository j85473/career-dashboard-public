import assert from 'node:assert/strict';
import test from 'node:test';
import { smartRecruitersLocation, smartRecruitersPostingLocation } from '../smartRecruitersLocation';
import { parseBoardPostings, locationsCompatibleForDirectMatch } from '../atsDirectMatch';
import { evaluateAuthoritativeGeography } from '../authoritativeMetadataGate';

const vericast = { city: 'Columbus', region: 'OH', country: 'us', remote: true, hybrid: false,
  fullLocation: 'Columbus, OH, United States' };
const passes = (location: unknown, title = 'Account Executive IV') => evaluateAuthoritativeGeography({
  title, location: smartRecruitersLocation(location),
}).passes;

test('Vericast remote flag survives canonical matching and the automatic geography gate', () => {
  const [posting] = parseBoardPostings('smartrecruiters', { content: [{
    id: '744000159537989', name: 'Account Executive IV', company: { identifier: 'Vericast' }, location: vericast,
  }] }, 'Vericast');
  assert.equal(posting.location, 'Remote - United States; Columbus, OH, United States');
  assert.equal(posting.location, smartRecruitersLocation(vericast));
  assert.equal(locationsCompatibleForDirectMatch('United States', posting.location), true);
  assert.equal(evaluateAuthoritativeGeography({ title: posting.title, location: posting.location }).passes, true);
  assert.equal(passes(vericast, 'Account Executive (must reside in Ohio)'), false);
});

test('remote metadata does not broaden hybrid, onsite, foreign or explicitly restricted locations', () => {
  for (const location of [
    { ...vericast, hybrid: true }, { ...vericast, remote: false }, { ...vericast, remote: 'true' },
    { city: 'Toronto', region: 'ON', country: 'ca', remote: true },
    { ...vericast, fullLocation: 'Columbus, OH (Ohio residents only)' },
    { ...vericast, fullLocation: 'Must reside in Ohio' },
    { ...vericast, fullLocation: 'Ohio' },
    { ...vericast, fullLocation: 'Ohio (Remote)' },
  ]) assert.equal(passes(location), false, JSON.stringify(location));
  assert.equal(passes({ ...vericast, city: 'Minneapolis', region: 'MN', remote: false, fullLocation: '' }), true);
});

test('listing without fullLocation retains country and remote flag without inventing worldwide eligibility', () => {
  assert.equal(smartRecruitersLocation({ ...vericast, fullLocation: undefined }), 'Remote - United States; Columbus, OH, United States');
  assert.equal(smartRecruitersLocation({ remote: true, country: 'ca' }), 'Remote - Canada');
  assert.equal(smartRecruitersLocation({ remote: true }), 'Remote');
  assert.equal(smartRecruitersLocation(null), null);
});

test('Adaptavist remote city retains Germany and the authored candidate location', () => {
  const job = { id: '744000156787039', name: 'Strategic Account Manager (DACH) (f/m/d)',
    location: { city: 'Remote', country: 'de', remote: false, hybrid: true, fullLocation: 'Remote, , Germany' },
    customField: [{ fieldLabel: 'Candidate Location', valueLabel: 'Germany' }] };
  assert.equal(smartRecruitersLocation(job.location), 'Hybrid - Remote, Germany');
  assert.equal(smartRecruitersPostingLocation(job), 'Hybrid - Germany');
  const [posting] = parseBoardPostings('smartrecruiters', { content: [job] }, 'TheAdaptavistGroup');
  assert.equal(posting.location, 'Hybrid - Germany');
  assert.equal(evaluateAuthoritativeGeography({ title: posting.title, location: posting.location }).passes, false);
});

test('generic remote address cannot discard its country, even with empty comma components', () => {
  for (const remote of [true, false]) {
    for (const fullLocation of ['Remote', 'Remote,', 'Remote, ,']) {
      const location = { city: 'Remote', country: 'de', remote, fullLocation };
      assert.match(smartRecruitersLocation(location)!, /Germany/);
      assert.equal(passes(location, 'Account Manager'), false);
    }
  }
});

test('candidate eligibility takes precedence over broad remote metadata, but not unrelated custom fields', () => {
  const job = { location: { remote: true, country: 'us' },
    customField: [{ fieldLabel: 'Candidate Location', valueLabel: 'Germany' }] };
  assert.equal(smartRecruitersPostingLocation(job), 'Remote - Germany');
  assert.equal(evaluateAuthoritativeGeography({ title: 'Account Manager', location: smartRecruitersPostingLocation(job) }).passes, false);
  assert.equal(smartRecruitersPostingLocation({ ...job, customField: [{ fieldLabel: 'Sales Territory', valueLabel: 'Germany' }] }), 'Remote - United States');
  assert.equal(smartRecruitersPostingLocation({ ...job, customField: [{ fieldLabel: 'Candidate Location', valueLabel: 'United States' }] }), 'Remote - United States');
  assert.equal(smartRecruitersPostingLocation({ ...job, customField: [{ fieldLabel: 'Candidate Location', valueLabel: '' }] }), 'Remote - United States');
});
