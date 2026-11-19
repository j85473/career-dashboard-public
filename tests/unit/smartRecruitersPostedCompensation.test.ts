import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSmartRecruitersPostingDetail } from '../../src/lib/atsApi';
import { planAtsPrequeueCompaction } from '../../src/lib/atsPrequeueCompaction';
import { smartRecruitersPostedCompensation, smartRecruitersPostingIdentity } from '../../src/lib/smartRecruitersPosting';

const id = '744000160945659';
const board = 'StepStoneGroup';
const canonical = `https://jobs.smartrecruiters.com/${board}/${id}`;
const example = {
  id, name: 'Director - Commercial Enablement', company: { name: 'StepStone Group', identifier: board }, active: true,
  postingUrl: `${canonical}-director-commercial-enablement`,
  compensation: { min: 96500, max: 160500, currency: 'USD', period: 'YEARLY' },
  jobAd: { sections: { jobDescription: { text: 'Lead commercial enablement.' } } },
};

test('structured SmartRecruiters pay comes from the exact posting even without a usable description', () => {
  const expected = smartRecruitersPostingIdentity(canonical)!;
  assert.deepEqual(expected, { board, id });
  assert.equal(parseSmartRecruitersPostingDetail(example, expected)?.postedCompensation, '$96,500–$160,500 per year');
  assert.equal(parseSmartRecruitersPostingDetail({ ...example, id: '744000160945660' }, expected), null);
  assert.equal(parseSmartRecruitersPostingDetail({ ...example, company: { identifier: 'OtherTenant' } }, expected), null);
  assert.equal(parseSmartRecruitersPostingDetail({ ...example, active: false }, expected), null);
  for (const changes of [{ currency: 'CAD' }, { period: undefined }, { min: '96500' }, { min: 0 }, { min: 180000 }]) {
    assert.equal(smartRecruitersPostedCompensation({ compensation: { ...example.compensation, ...changes } }), null);
  }
});

test('only exact active SmartRecruiters cards with missing pay bypass normal duplicate compaction', () => {
  const job = { id, name: example.name };
  const plan = (status: string, url: string | null) => planAtsPrequeueCompaction({
    platform: 'smartrecruiters', boardSlug: board, jobs: [job],
    observations: [{ sourceId: id, jobId: 'saved', jobStatus: status, boardSlug: board,
      jobUpdatedAt: new Date(0).toISOString(), compensationRefreshUrl: url }],
  });
  assert.deepEqual(plan('applied', example.postingUrl).jobs, [job]);
  assert.equal(plan('applied', null).jobs.length, 0);
  assert.equal(plan('applied', canonical.replace(board, 'OtherCompany')).jobs.length, 0);
  assert.equal(plan('applied', canonical.replace(id, '744000160945660')).jobs.length, 0);
  assert.equal(plan('archived', canonical).jobs.length, 0);
});
