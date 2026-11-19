import assert from 'node:assert/strict';
import test from 'node:test';

import type { DirectAtsMatch } from '../atsDirectMatch';
import type { PostingVerification } from '../jobPostingVerification';
import { verifyJSearchBeforeAim, verifyWorkdayBeforeAim, workdayVerificationRetryWhere } from '../preAimPostingVerification';
import type { Prisma } from '../prismaClient';

const job = {
  title: 'Channel Account Manager',
  company: 'Acme',
  location: 'Minneapolis, MN',
  description: 'Responsibilities include building partner plans and growing channel revenue.',
  url: 'https://www.jobleads.com/us/job/channel-account-manager--acme--123',
  canonicalUrl: null,
  source: 'JSearch',
};

const employerUrl = 'https://job-boards.greenhouse.io/acme/jobs/12345';
const employerMatch: DirectAtsMatch = {
  url: employerUrl,
  description: job.description,
  platform: 'greenhouse',
  slug: 'acme',
  matchedVia: 'stored',
  matchedBy: 'title',
  postingTitle: job.title,
  postingLocation: job.location,
};
const store = {} as Prisma.TransactionClient;
const result = (liveness: PostingVerification['liveness'], url: string): PostingVerification => ({
  liveness,
  probes: [{ url, status: liveness === 'expired' ? 404 : 200, outcome: liveness, reason: 'test' }],
});

test('a live employer posting repairs an aggregator link before Aim', async () => {
  const checked: string[] = [];
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => employerMatch,
    verify: async posting => {
      checked.push(posting.url);
      return result('alive', posting.url);
    },
  });

  assert.deepEqual(checked, [employerUrl]);
  assert.equal(verification.liveness, 'alive');
  assert.equal(verification.authority, 'employer_posting');
  assert.equal(verification.replacement?.url, employerUrl);
});

test('a closed employer posting wins over an aggregator copy that could still render', async () => {
  const checked: string[] = [];
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => employerMatch,
    verify: async posting => {
      checked.push(posting.url);
      return result('expired', posting.url);
    },
  });

  assert.deepEqual(checked, [employerUrl]);
  assert.equal(verification.liveness, 'expired');
  assert.equal(verification.authority, 'employer_posting');
  assert.equal(verification.replacement, null);
});

test('a live aggregator without an employer match remains eligible but unverified', async () => {
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => null,
    verify: async posting => result('alive', posting.url),
  });

  assert.equal(verification.liveness, 'inconclusive');
  assert.equal(verification.sourceLiveness, 'alive');
  assert.equal(verification.authority, 'unresolved_aggregator');
  assert.equal(verification.replacement, null);
});

test('a confirmed closed source copy expires when no employer posting can be found', async () => {
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => null,
    verify: async posting => result('expired', posting.url),
  });

  assert.equal(verification.liveness, 'expired');
  assert.equal(verification.sourceLiveness, 'expired');
  assert.equal(verification.authority, 'source_copy');
});

test('a recognized employer URL is authoritative and bypasses aggregator resolution', async () => {
  const direct = { ...job, url: employerUrl, canonicalUrl: employerUrl };
  const verification = await verifyJSearchBeforeAim(direct, {
    store,
    resolveCanonical: async () => { throw new Error('direct employer links must not be resolved as aggregators'); },
    verify: async posting => result('alive', posting.url),
  });

  assert.equal(verification.liveness, 'alive');
  assert.equal(verification.authority, 'employer_posting');
  assert.equal(verification.replacement, null);
});

test('a verified direct Workday URL replaces stale aggregator geography before Aim', async () => {
  const locations = 'Atlanta, GA; Charlotte, NC; Nashville, TN';
  const verification = await verifyJSearchBeforeAim({ ...job, canonicalUrl: workday.url, location: 'Anywhere' }, {
    store,
    verify: async posting => ({ ...result('alive', posting.url), postingLocation: locations }),
  });
  assert.equal(verification.replacement?.url, workday.url);
  assert.equal(verification.replacement?.postingLocation, locations);
});

test('employer lookup failures stay inconclusive instead of expiring the job', async () => {
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => { throw new Error('catalogue unavailable'); },
    verify: async () => { throw new Error('source should not be treated as authoritative after lookup failure'); },
  });

  assert.equal(verification.liveness, 'inconclusive');
  assert.equal(verification.authority, 'unresolved_aggregator');
});

const workday = {
  title: 'Channel Account Manager',
  url: 'https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Minneapolis/Channel-Account-Manager_R123',
};
const workdayDescription = 'Responsibilities include growing a book of channel accounts. '
  + 'Qualifications include five years of experience in partner management. '
  + 'Build joint business plans, report opportunities, and enable your partners to sell services. '.repeat(10);

function renderedWorkday(body: string, url = workday.url) {
  return new Response(`Title: ${workday.title}\n\nURL Source: ${url}\n\nMarkdown Content:\n${body}`);
}

test('a successful Workday detail payload cannot override a missing public application page', async () => {
  const verification = await verifyWorkdayBeforeAim(workday, {
    fetchPosting: async url => {
      assert.equal(url, workday.url);
      return Response.json({ jobPostingInfo: { title: workday.title, jobDescription: workdayDescription } });
    },
    readPosting: async url => {
      assert.equal(url, workday.url);
      return renderedWorkday("The page you are looking for doesn't exist.");
    },
  });
  assert.equal(verification.liveness, 'expired');
  assert.deepEqual(verification.probes.map(p => p.outcome), ['inconclusive', 'expired']);
});

test('Workday candidate verification accepts a matching rendered posting', async () => {
  const verification = await verifyWorkdayBeforeAim(workday, {
    fetchPosting: async () => new Response('<title>Careers</title><main>Search Jobs</main>'),
    readPosting: async () => renderedWorkday(`## ${workday.title}\n\n${workdayDescription}`),
  });
  assert.equal(verification.liveness, 'alive');
});

test('Workday candidate verification defers access failures and rejects redirected closure evidence', async () => {
  const closure = "The page you are looking for doesn't exist.";
  const other = workday.url.replace('_R123', '_R456');
  const redirected = new Response('Not found', { status: 404 });
  Object.defineProperty(redirected, 'url', { value: other });
  for (const response of [new Response('Denied', { status: 403 }), new Response('Rate limited', { status: 429 })]) {
    const verification = await verifyWorkdayBeforeAim(workday, {
      fetchPosting: async () => response,
      readPosting: async () => renderedWorkday(closure, other),
    });
    assert.equal(verification.liveness, 'inconclusive');
  }
  const redirectedPage = await verifyWorkdayBeforeAim(workday, {
    fetchPosting: async () => redirected,
    readPosting: async () => renderedWorkday(closure),
  });
  assert.equal(redirectedPage.liveness, 'inconclusive');
  assert.equal(redirectedPage.probes.length, 1);
  const unverifiableReader = await verifyWorkdayBeforeAim(workday, {
    fetchPosting: async () => { throw new Error('timeout'); },
    readPosting: async () => new Response(closure),
  });
  assert.equal(unverifiableReader.liveness, 'inconclusive');
});

test('inconclusive Workday checks retry after fifteen minutes', () => {
  const predicate = workdayVerificationRetryWhere(new Date('2026-11-18T20:15:00Z'));
  assert.ok(predicate.OR?.some(condition => condition.source === null));
  assert.ok(predicate.OR?.some(condition => condition.verificationStatus
    && typeof condition.verificationStatus === 'object'
    && condition.verificationStatus.not === 'inconclusive'));
  assert.deepEqual(predicate.OR?.at(-1), { lastVerifiedAt: { lte: new Date('2026-11-18T20:00:00Z') } });
});
