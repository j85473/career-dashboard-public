import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateAuthoritativeMetadata,
  hasAuthoritativeMetadata,
} from '../authoritativeMetadataGate';

/**
 * Lane one of local scoring: the checks that run *before* JD recovery, for
 * sources whose metadata is authoritative on arrival.
 *
 * Lane two still runs after recovery, because for an aggregator the location
 * is a guess that resolving the description often corrects — rejecting early
 * there would discard good roles on bad data. A direct ATS board publishes the
 * posting's own location and title, so there is nothing to wait for.
 *
 * Both checks in lane one must therefore be description-independent, and the
 * lane must stay scoped to authoritative sources. Both are asserted below.
 */
const metadataGate = evaluateAuthoritativeMetadata;

test('the gate applies to authored ATS and external-source metadata, not inferred aggregators', () => {
  assert.equal(hasAuthoritativeMetadata('ATS-pinpoint'), true);
  assert.equal(hasAuthoritativeMetadata('ATS-greenhouse'), true);
  assert.equal(hasAuthoritativeMetadata('Glassdoor (RapidAPI)'), true);
  // CareerForce is Minnesota's state job board and reads location directly
  // off the search card, not an inferred field. ingestExternalJob writes it
  // lowercase, unlike the ATS-* sources, so the match must be case-insensitive.
  assert.equal(hasAuthoritativeMetadata('careerforce'), true);
  assert.equal(hasAuthoritativeMetadata('CareerForce'), true);
  assert.equal(hasAuthoritativeMetadata('Dejobs'), true);
  assert.equal(hasAuthoritativeMetadata('dejobs'), true);
  // An aggregator infers location rather than stating it, so it keeps the
  // slower path where the JD can still correct the metadata. The recovery
  // route and the retroactive cleanup script share this predicate, so a
  // drift here would have one of them dismissing rows the pipeline would keep.
  assert.equal(hasAuthoritativeMetadata('Adzuna'), false);
  assert.equal(hasAuthoritativeMetadata('Himalayas'), false);
  assert.equal(hasAuthoritativeMetadata('TheMuse'), false);
  assert.equal(hasAuthoritativeMetadata('Indeed'), false);
  assert.equal(hasAuthoritativeMetadata('RemoteOK'), false);
  assert.equal(hasAuthoritativeMetadata(null), false);
});

test('explicit DEjobs locations reject both domestic and foreign out-of-area postings', () => {
  for (const fixture of [
    {
      title: 'Area Sales Manager (Remote in Atlanta area)',
      company: 'IDEAL INDUSTRIES, INC.',
      location: 'Atlanta, Georgia',
    },
    {
      title: 'Regional Account Manager Computer Associates',
      company: 'Arrow Electronics',
      location: 'Courbevoie, FRA',
    },
  ]) {
    assert.equal(hasAuthoritativeMetadata('Dejobs'), true);
    const verdict = metadataGate(fixture);
    assert.equal(verdict.passes, false, `${fixture.location}: ${verdict.reason}`);
    assert.match(verdict.reason, /(?:outside the searched geographies|non-local territory)/i);
  }
});

test('a foreign ATS posting is rejected with no description at all', () => {
  const verdict = metadataGate({
    title: 'Account Executive',
    company: 'Acme Ltd',
    location: 'London, United Kingdom',
  });
  assert.equal(verdict.passes, false);
  assert.match(verdict.reason, /outside the searched geographies/i);
});

test('an internship is rejected on title alone', () => {
  const verdict = metadataGate({
    title: 'Sales Internship',
    company: 'Acme',
    location: 'Minneapolis, MN',
  });
  assert.equal(verdict.passes, false);
  assert.match(verdict.reason, /internship/i);
});

test('an explicitly excluded employer is dismissed before direct-board JD recovery', () => {
  const verdict = metadataGate({
    title: 'Dell Territory Sales Representative',
    company: '2020 Companies, Inc.',
    location: 'Minneapolis, MN',
  });
  assert.equal(verdict.passes, false);
  assert.equal(verdict.reason, 'Locally triaged out: Employer excluded from local scoring (2020 Companies)');
});

test('DSI Systems is excluded before JD recovery using the full employer name or its Workable posting', () => {
  const posting = { title: 'Account Sales Manager - EDM', location: 'United States' };
  for (const identity of [
    { company: 'DSI Systems' },
    { company: '  DSI   Systems Inc  ' },
    { company: 'DSI Systems, Inc.' },
    { company: 'DSI', url: 'https://apply.workable.com/dsi-systems/j/B90E49489D?source=career' },
  ]) {
    assert.deepEqual(metadataGate({ ...posting, ...identity }), {
      passes: false, reason: 'Locally triaged out: Employer excluded from local scoring (DSI Systems)',
    });
  }
  for (const identity of [
    { company: 'DSI' },
    { company: 'DSI Holdings Corporation' },
    { company: 'Dsi', url: 'https://jobs.lever.co/dsi/d7902717-96b3-46d4-bfe9-0044180cc17f' },
    { company: 'DSI', url: 'https://apply.workable.com/dsi-systems-partners/j/B90E49489D' },
    { company: 'DSI', url: 'https://apply.workable.com.example.org/dsi-systems/j/B90E49489D' },
  ]) assert.equal(metadataGate({ ...posting, ...identity }).passes, true);
});

test('AutoZone Parts Sales Manager is excluded before JD recovery even in the local metro', () => {
  for (const title of ['Part Sales Manager – Full Time', 'Parts Sales Manager - Part Time']) {
    const verdict = metadataGate({ company: 'AutoZone', title, location: 'Anoka, MN' });
    assert.deepEqual(verdict, {
      passes: false,
      reason: 'Locally triaged out: Role excluded from local scoring (AutoZone Parts Sales Manager)',
    });
  }
  assert.equal(metadataGate({
    company: 'AutoZone', title: 'Commercial Sales Manager', location: 'Anoka, MN',
  }).passes, true);
});

test('AO Garcia Agency Lever postings are excluded before JD recovery or AI review', () => {
  const verdict = metadataGate({
    title: 'Channel Account Manager',
    company: 'Aogarciaagency',
    location: 'Remote',
  });
  assert.equal(verdict.passes, false);
  assert.equal(verdict.reason, 'Locally triaged out: Employer excluded from local scoring (AO Garcia Agency)');
});

test('in-scope postings survive the gate even with no description', () => {
  for (const location of ['Minneapolis, MN', 'Remote', 'United States', '', null]) {
    const verdict = metadataGate({ title: 'Partner Manager', company: 'Acme', location });
    assert.equal(verdict.passes, true, `rejected for location ${JSON.stringify(location)}: ${verdict.reason}`);
  }
});

test('a multi-site posting that includes the metro is kept', () => {
  const verdict = metadataGate({
    title: 'Channel Account Manager',
    company: 'Acme',
    location: 'Austin, TX; London, UK; Minneapolis, MN',
  });
  assert.equal(verdict.passes, true, verdict.reason);
});

test('Workday address state takes precedence over a matching Twin Cities name', () => {
  const posting = {
    title: 'Bilingual Spanish Retail Sales Consultant - FORT LAUDERDALE',
    company: 'AT&T Mobility Services LLC',
    location: 'USA:FL:Fort Lauderdale:530 N Federal Hwy:RET/RET',
  };
  const verdict = metadataGate(posting);
  assert.equal(verdict.passes, false);
  assert.match(verdict.reason, /outside the searched geographies/i);
  assert.equal(metadataGate({
    ...posting, location: 'USA:IN:Bloomington:260 N Jacob Dr:RET/RET',
  }).passes, false);
});

test('Workday address triage keeps genuine local and remote alternatives and uses the published city', () => {
  const florida = 'USA:FL:Fort Lauderdale:530 N Federal Hwy:RET/RET';
  const local = 'USA:MN:Lauderdale:123 Main St:RET/RET';
  for (const location of [
    local,
    'USA:MN:Blaine:123 Main St:RET/RET',
    'USA:MN:Minneapolis / 123 Main St - Adm:123 Main St',
    'USA:WI:Hudson:123 Main St:RET/RET',
    florida + '; ' + local,
    florida + ' | Remote - US',
  ]) assert.equal(metadataGate({ title: 'Partner Manager', company: 'Acme', location }).passes, true, location);
  for (const location of [
    'USA:MN:Rochester:123 Minneapolis Ave:RET/RET',
    florida + '; USA:NY:Woodbury:123 Main St:RET/RET',
  ]) assert.equal(metadataGate({ title: 'Partner Manager', company: 'Acme', location }).passes, false, location);
});

test('ambiguous employer remote labels are not rejected before JD recovery', () => {
  for (const location of ['REMOTE • Sales - BOSTONtec', 'US - California - Vista; Watkins - Remote']) {
    const verdict = metadataGate({ title: 'Regional Sales Manager', company: 'Acme', location });
    assert.equal(verdict.passes, true, `${location}: ${verdict.reason}`);
  }
});

test('a Workday placeholder cannot conceal a foreign location encoded in its URL', () => {
  for (const url of [
    'https://example.wd3.myworkdayjobs.com/en-US/jobs/job/Remote-Sweden/Partner-Manager_R1',
    'https://example.wd5.myworkdayjobs.com/en-US/jobs/job/Tijuana-Mexico/Account-Executive_R2',
    'https://example.wd1.myworkdaysite.com/recruiting/jobs/job/Home-Based-Spain/Sales-Manager_R3',
  ]) {
    const verdict = metadataGate({
      title: 'Partner Manager',
      company: 'Acme',
      location: '2 Locations',
      url,
    });
    assert.equal(verdict.passes, false, url);
    assert.match(verdict.reason, /outside the searched geographies/i);
  }
});

test('a Workday placeholder cannot conceal a country absent from the name/code lists', () => {
  // Thailand is in neither INTERNATIONAL_LOCATION nor
  // INTERNATIONAL_COUNTRY_CODE (jobLocationPolicy.ts), so this only rejects
  // because the recovered URL fragment carries no confirmed US state
  // evidence — not because "Thailand" or "TH" is a recognized name. That is
  // the actual regression case for job 652565cc-ef46-40f6-9eeb-b2f8d234cb4d
  // (Goodyear "Key Account Executive", Pathumthani, Thailand), which passed
  // geography triage on 2026-08-12 while both its Workday locations were
  // foreign, and it is deliberately unfixed by adding Thailand to a list:
  // the next uncovered country would reopen the same hole.
  const verdict = metadataGate({
    title: 'Key Account Executive',
    company: 'Acme',
    location: '2 Locations',
    url: 'https://acme.wd1.myworkdayjobs.com/en-US/acmecareers/job/TH-Pathumthani-Non-Plant/Key-Account-Manager_JR1',
  });
  assert.equal(verdict.passes, false, verdict.reason);
  assert.match(verdict.reason, /outside the searched geographies/i);
});

test('a Workday placeholder with a US URL remains unknown rather than falsely narrowed', () => {
  const verdict = metadataGate({
    title: 'Partner Manager',
    company: 'Acme',
    location: '2 Locations',
    url: 'https://example.wd3.myworkdayjobs.com/en-US/jobs/job/Youngstown-Ohio/Partner-Manager_R1',
  });
  assert.equal(verdict.passes, true, verdict.reason);
});
