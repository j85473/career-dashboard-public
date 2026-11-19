import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATT_FIELD_SALES_EXCLUSION_REASON,
  CUSTOMER_SUCCESS_EXCLUSION_REASON,
  PART_TIME_EXCLUSION_REASON,
  filterNewIntakeRole,
  isExcludedCustomerSuccessTitle,
} from '../newIntakeRoleExclusion';

const intake = {
  id: 'new-job', title: 'Customer Success Manager', status: 'pending_af',
  company: 'Example', url: 'https://example.com/jobs/123', canonicalUrl: null,
  source: 'ATS-greenhouse', description: null, tailoringStaged: false,
  fitScore: null, aimFitScore: null, reqFitScore: null, travelScore: null,
};

test('excludes customer/client success occupations across seniority and title formatting', () => {
  for (const title of [
    'Customer Success Manager', 'Senior Customer Success Manager',
    'Client Success Manager, Scale', 'Director of Customer Success',
    'Head of Client Success', 'Customer Success Associate',
    'Coordinator, Client Success', 'Clinical Customer Success Specialist',
    'Enterprise CSM', 'Go-to-Market Strategist (CSM)',
    'Customer-Success Manager', 'CUSTOMER–SUCCESS LEAD',
    'Customer   Success Manager', 'Customer Success Manager - Channel Partners',
  ]) assert.equal(isExcludedCustomerSuccessTitle(title), true, title);
});

test('keeps partner/channel/distributor and account occupations eligible', () => {
  for (const title of [
    'Partner Success Manager', 'Channel Success Manager', 'Distributor Manager',
    'Distribution Partner Manager', 'Account Manager', 'Strategic Account Director',
    'Principal Partner Success Specialist, ASP Customer Success',
    'Account Manager, Client Success', 'Customer Success Account Manager',
    'Channel Account Manager - Customer Success',
    'Client Services Manager', 'Customer Experience Manager', 'CSMITH Sales Manager',
    'Territory Sales Manager',
  ]) assert.equal(isExcludedCustomerSuccessTitle(title), false, title);
});

test('new CS intake is dismissed with a reason and atomic protection for existing work', async () => {
  let writes = 0;
  const filtered = await filterNewIntakeRole(intake, 'local:lease', async ({ where, data }) => {
    writes++;
    assert.deepEqual(where, {
      id: intake.id, title: intake.title, status: 'pending_af',
      company: intake.company, url: intake.url, canonicalUrl: intake.canonicalUrl,
      scoringStatus: 'scoring', batchJobId: 'local:lease', tailoringStaged: false,
      fitScore: null, aimFitScore: null, reqFitScore: null, travelScore: null,
      AND: [{ OR: [{ source: null }, { source: { not: 'Manual Import' } }] }],
      scoreEvents: { none: {} }, scoringArtifacts: { none: {} },
      aimFactualExtractions: { none: {} },
      statusHistory: { none: { status: { not: 'pending_af' } } },
    });
    assert.deepEqual(data, {
      status: 'dismissed', scoringStatus: 'skipped',
      passReason: CUSTOMER_SUCCESS_EXCLUSION_REASON,
      batchJobId: null, scoreAttempts: 0, scoreError: null,
    });
    return { count: 1 };
  });
  assert.equal(filtered, CUSTOMER_SUCCESS_EXCLUSION_REASON);
  assert.equal(writes, 1);
});

test('existing scores, Inbox cards, lifecycle decisions and manual selections never reach the writer', async () => {
  for (const patch of [
    { fitScore: 0 }, { fitScore: 85 }, { aimFitScore: 87 }, { reqFitScore: 87 },
    { travelScore: 80 }, { tailoringStaged: true }, { source: 'Manual Import' },
    ...['inbox', 'applied', 'interviewing', 'bookmarked', 'cooldown', 'expired', 'passed', 'dismissed', 'archived']
      .map((status) => ({ status })),
    { title: 'Partner Success Manager' }, { title: 'Account Manager' },
  ]) {
    const filtered = await filterNewIntakeRole({ ...intake, ...patch }, 'local:lease', async () => {
      assert.fail(`Protected work reached the writer: ${JSON.stringify(patch)}`);
    });
    assert.equal(filtered, null, JSON.stringify(patch));
  }
});

test('a concurrent score, user action or lost lease prevents disposition', async () => {
  assert.equal(await filterNewIntakeRole(intake, 'local:old-lease', async () => ({ count: 0 })), null);
});

const attPosting = { ...intake, company: 'AT&T Mobility Services LLC', title: 'Field Sales Representative' };
const attWorkdayUrl = 'https://att.wd1.myworkdayjobs.com/en-US/ATTGeneral/job/Coon-Rapids-Minnesota/Field-Sales-Representative_R-129214';

test('new AT&T Field Sales Representative intake is excluded by direct employer or Workday board', async () => {
  for (const posting of [
    attPosting,
    { ...attPosting, company: '  At&T, Inc. ', title: 'FIELD  SALES REPRESENTATIVE' },
    { ...attPosting, company: 'att.wd1', url: attWorkdayUrl },
  ]) {
    assert.equal(await filterNewIntakeRole(posting, 'local:lease', async ({ data }) => {
      assert.equal(data.passReason, ATT_FIELD_SALES_EXCLUSION_REASON);
      assert.equal(data.scoringStatus, 'skipped');
      assert.equal(data.status, 'dismissed');
      return { count: 1 };
    }), ATT_FIELD_SALES_EXCLUSION_REASON);
  }
});

test('recovered AT&T posting identity is matched against the stored job and lease', async () => {
  const aggregator = { ...intake, title: 'Sales Representative' };
  const recovered = { ...aggregator, title: attPosting.title, canonicalUrl: attWorkdayUrl };
  assert.equal(await filterNewIntakeRole(aggregator, 'local:lease', async ({ where, data }) => {
    assert.equal(where?.title, aggregator.title);
    assert.equal(where?.canonicalUrl, aggregator.canonicalUrl);
    assert.equal(data.title, recovered.title);
    return { count: 1 };
  }, recovered), ATT_FIELD_SALES_EXCLUSION_REASON);
});

test('the AT&T role exclusion preserves other employers, other titles, and existing work', async () => {
  for (const posting of [
    { ...attPosting, fitScore: 79 },
    { ...attPosting, status: 'passed' },
    { ...attPosting, source: 'Manual Import' },
    { ...attPosting, title: 'Field Sales Manager', url: attWorkdayUrl },
    { ...attPosting, title: 'Senior Field Sales Representative', url: attWorkdayUrl },
    { ...attPosting, company: 'AT&T Authorized Retailer' },
    { ...attPosting, company: 'Example', canonicalUrl: 'https://att.wd1.myworkdayjobs.com.example.org/job/123' },
  ]) {
    assert.equal(await filterNewIntakeRole(posting, 'local:lease', async () => {
      assert.fail(`Unmatched or protected job reached the writer: ${JSON.stringify(posting)}`);
    }), null);
  }
});

test('explicit part-time titles and job description statements are dismissed before Aim', async () => {
  for (const [title, description] of [
    ['Part Time Retail Sales Consultant', 'Weekly Hours:\n20\nTime Type:\nRegular'],
    ['Account Manager (Part‑Time)', 'Support assigned accounts.'],
    ['Partner Manager – Part-Time – Remote', 'Support assigned partners.'],
    ['Account Manager', '- **Employment Type:** PART_TIME\nSupport assigned accounts.'],
    ['Partner Manager', 'Time Type\r\nRegular Part-Time\r\nSupport assigned partners.'],
    ['Account Manager', 'This is a part-time role that offers benefits available to full-time employees.'],
    ['Account Manager', 'The position is part time. Support assigned accounts.'],
  ]) {
    const job = { ...intake, title, description };
    assert.equal(await filterNewIntakeRole(job, 'local:lease', async ({ data }) => {
      assert.equal(data.status, 'dismissed');
      assert.equal(data.scoringStatus, 'skipped');
      assert.equal(data.passReason, PART_TIME_EXCLUSION_REASON);
      assert.equal(data.fitScore, undefined);
      return { count: 1 };
    }, { ...job, resolvedDescription: description }), PART_TIME_EXCLUSION_REASON, title + ' / ' + description);
  }
});

test('part-time references, alternatives, and hours alone do not establish the opening is part-time', async () => {
  for (const [title, description] of [
    ['Manager of Part-Time Sales Staff', 'Manage part-time staff.'],
    ['Account Manager', 'Full-time and part-time employees receive a discount.'],
    ['Account Manager', 'Job Type: Full-Time\nPart-time experience is welcome.'],
    ['Account Manager', 'Work Schedule: Must be available to supervise part-time staff.'],
    ['Account Manager', 'Job Type: Part Time or Full Time'],
    ['Account Manager', 'This is a part-time position or a full-time position, depending on availability.'],
    ['Account Manager', 'This position is part-time eligible.'],
    ['Account Manager - Full/Part-Time', 'Manage regional accounts.'],
    ['Account Manager (Part-Time)', 'Employment Type: Full-Time'],
    ['Account Manager', 'Weekly Hours: 20'],
  ]) {
    const job = { ...intake, title, description };
    assert.equal(await filterNewIntakeRole(job, 'local:lease', async () => {
      assert.fail('Ambiguous or incidental schedule evidence reached the writer');
    }, { ...job, resolvedDescription: description }), null, title + ' / ' + description);
  }
});

test('recovered part-time evidence is retained and checked against the stored JD and lease', async () => {
  const job = { ...intake, title: 'Account Manager', description: 'Short snippet' };
  const posting = { ...job, resolvedDescription: 'Job Type: Part-Time\nManage a portfolio of regional accounts.' };
  assert.equal(await filterNewIntakeRole(job, 'local:lease', async ({ where, data }) => {
    assert.equal(where?.description, job.description);
    assert.equal(where?.batchJobId, 'local:lease');
    assert.equal(where?.fitScore, null);
    assert.equal(data.description, posting.resolvedDescription);
    return { count: 1 };
  }, posting), PART_TIME_EXCLUSION_REASON);

  for (const protectedJob of [{ ...job, fitScore: 45 }, { ...job, source: 'Manual Import' }, { ...job, status: 'inbox' }]) {
    assert.equal(await filterNewIntakeRole(protectedJob, 'local:lease', async () => {
      assert.fail('Protected work reached the part-time exclusion writer');
    }, posting), null);
  }
});
