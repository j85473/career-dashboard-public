import assert from 'node:assert/strict';
import test from 'node:test';
import { ATS_DISCOVERY_PLATFORMS, FUTURE_ATS_DISCOVERY_PATTERNS, discoveryCandidateStatus, futureAtsCandidateUrl } from '../../src/lib/atsDiscoveryPlatforms';
import { PLATFORMS } from '../../src/scripts/discoverATS';
import { isFirstCollectionPlatform } from '../../src/lib/atsFirstCollectionAdmission';
import { extractAuditCandidates, auditIndicesMissingCoverage } from '../../scripts/audit_ats_common_crawl';
import { localCrawlPatternMatches } from '../../src/lib/localCommonCrawl';

const samples = {
  cornerstone: ['https://interfor.csod.com/ux/ats/careersite/7/home/requisition/123', 'https://interfor.csod.com/ux/ats/careersite/7/home'],
  hireology: ['https://careers.hireology.com/beachchevrolet/123/description', 'https://careers.hireology.com/beachchevrolet'],
  polymer: ['https://api.polymer.co/v1/hire/organizations/aboard/jobs/41188', 'https://jobs.polymer.co/aboard'],
  homerun: ['https://example.homerun.co/account-manager', 'https://example.homerun.co/'],
  softgarden: ['https://example.jobs.softgarden.io/job/123/sales', 'https://example.jobs.softgarden.io/'],
  dvinci: ['https://example.dvinci-hr.com/portal/external/jobPublication/list.json', 'https://example.dvinci-hr.com/portal/external/'],
  flatchr: ['https://careers.flatchr.io/fr/company/example.json', 'https://careers.flatchr.io/company/example'],
} as const;

test('future platforms are harvested without creating a schedulable collector or admission path', () => {
  for (const platform of Object.keys(samples) as (keyof typeof samples)[]) {
    assert.equal(Object.hasOwn(PLATFORMS, platform), false);
    assert.equal(isFirstCollectionPlatform(platform), false);
    assert.equal(discoveryCandidateStatus(platform), 'awaiting_adapter');
    const [url, expected] = samples[platform];
    assert.equal(futureAtsCandidateUrl(platform, url), expected);
    assert.ok(FUTURE_ATS_DISCOVERY_PATTERNS[platform].some(pattern => localCrawlPatternMatches(pattern, url)));
    assert.deepEqual(extractAuditCandidates(platform, [{ url }, { url }]), [{ slug: expected, normalizedSlug: expected.toLowerCase() }]);
  }
  assert.equal(discoveryCandidateStatus('greenhouse'), 'pending');
  assert.equal(ATS_DISCOVERY_PLATFORMS.greenhouse, PLATFORMS.greenhouse);
});

test('aliases retain published site scopes and refuse infrastructure or foreign hosts', () => {
  assert.equal(futureAtsCandidateUrl('cornerstone', 'https://interfor.csod.com/ats/careersite/JobDetails.aspx?id=123&site=7'), samples.cornerstone[1]);
  assert.equal(futureAtsCandidateUrl('hireology', 'https://fieldsautogroup.hireology.careers/jobs'), 'https://fieldsautogroup.hireology.careers/');
  assert.equal(futureAtsCandidateUrl('homerun', 'https://feed.homerun.co/jobs?utm_source=test'), 'https://feed.homerun.co/jobs');
  for (const platform of Object.keys(samples) as (keyof typeof samples)[]) {
    assert.equal(futureAtsCandidateUrl(platform, 'https://evil.example/'), null);
    assert.equal(futureAtsCandidateUrl(platform, samples[platform][0].replace('https://', 'https://user:password@')), null);
    assert.equal(futureAtsCandidateUrl(platform, samples[platform][0].replace('https://', 'file://')), null);
  }
  for (const [platform, url] of [['cornerstone', 'https://api.csod.com/ux/ats/careersite/1/home'], ['homerun', 'https://help.homerun.co/jobs'], ['polymer', 'https://jobs.polymer.co.evil.example/aboard'], ['softgarden', 'https://api.softgarden.io/']] as const) assert.equal(futureAtsCandidateUrl(platform, url), null);
});

test('old-provider receipts cannot establish historical coverage for the new patterns', () => {
  const indices = ['CC-MAIN-2026-38-index', 'CC-MAIN-2026-43-index'];
  const work = [{ platformKey: 'cornerstone' as const, pattern: '*.csod.com/*' }];
  const old = indices.map(indexId => ({ platform: 'greenhouse', pattern: 'boards.greenhouse.io/*', indexId }));
  assert.deepEqual(auditIndicesMissingCoverage(indices, work, old), indices);
});
