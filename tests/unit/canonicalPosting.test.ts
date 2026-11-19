import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAuthoritativeMetadata } from '../../src/lib/authoritativeMetadataGate';
import { canonicalEmployerPostingUrl, canonicalPostingDescription, readCanonicalPosting } from '../../src/lib/canonicalPosting';
import { parseOraclePostingDetail } from '../../src/lib/oraclePosting';

const oracleUrl = 'https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19262/';
const dejobsUrl = 'https://dejobs.org/virtual-nor/business-development-manager/ABFE2F1670894295B1CBBF2B48381405/job';
const source = { title: 'Business Development Manager', company: 'Resideo', location: 'Virtual, NOR' };
const employer = {
  Id: '19262', Title: source.title, LegalEmployer: 'Resideo', PrimaryLocation: 'Norway',
  workLocation: [{ TownOrCity: 'Drammen', Country: 'NO' }], WorkplaceTypeCode: 'ORA_REMOTE',
};

test('Oracle location controls pre-Aim triage even if the syndicated copy supplies the description', async () => {
  assert.equal(evaluateAuthoritativeMetadata({ ...source, url: dejobsUrl }).passes, true);

  const posting = await readCanonicalPosting(canonicalEmployerPostingUrl(oracleUrl), async requested => {
    assert.equal(requested, oracleUrl);
    return parseOraclePostingDetail({ items: [employer] }, requested);
  });
  assert.equal(posting?.location, 'Drammen, NO (Remote)');
  assert.equal(canonicalPostingDescription(posting?.text), undefined);

  const triage = evaluateAuthoritativeMetadata({ ...source, ...posting, location: posting!.location!, url: oracleUrl });
  assert.equal(triage.passes, false);
  assert.match(triage.reason, /Drammen, NO/);
});

test('unavailable employers, unrelated postings, and syndicated URLs carry no canonical location evidence', async () => {
  for (const url of [dejobsUrl, 'https://click.appcast.io/jobs/123', new URL('../../', oracleUrl).href]) {
    const candidate = canonicalEmployerPostingUrl(url);
    assert.equal(candidate, null, url);
    assert.equal(await readCanonicalPosting(candidate, async () => assert.fail('must not fetch a reprint or board')), null);
  }

  assert.equal(await readCanonicalPosting(oracleUrl, async () => { throw new Error('timeout'); }), null);
  assert.equal(await readCanonicalPosting(oracleUrl, async url =>
    parseOraclePostingDetail({ items: [{ ...employer, Id: 'other' }] }, url)), null);
  const refused = await readCanonicalPosting(oracleUrl, async () => ({
    ats: 'Oracle Cloud', text: 'An unrelated posting', location: 'Minneapolis, MN', postingVerificationError: 'Wrong requisition',
  }));
  assert.deepEqual(refused, { ats: 'Oracle Cloud', text: '', postingVerificationError: 'Wrong requisition' });
});
