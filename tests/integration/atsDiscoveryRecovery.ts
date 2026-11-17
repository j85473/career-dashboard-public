import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../src/lib/prismaClient';
import { catalogueDiscoveryRecovery, discoveryRecoverySnapshot, recoverDiscoveryCandidate, runDiscoveryRecovery } from '../../src/lib/atsDiscoveryValidationRecovery';

const database = process.env.ATS_DISCOVERY_TEST_DATABASE_URL || '';
const address = new URL(database);
if (!['127.0.0.1', 'localhost'].includes(address.hostname) || !/^\/career_capacity_fixtures_discovery_[a-z0-9_]+$/.test(address.pathname)) {
  throw Error('Use an explicitly named isolated local discovery fixture database');
}
const db = new PrismaClient({ datasourceUrl: database });
const prefix = `discovery-${randomUUID().slice(0, 8)}`;
const past = new Date(Date.now() - 86_400_000), future = new Date(Date.now() + 7 * 86_400_000);
async function main() {
  const run = await db.atsDiscoveryAuditRun.create({ data: { status: 'complete_with_unresolved', targetIndexId: 'fixture-index', indexCount: 1, patternCount: 1 } });
  const receipt = await db.atsDiscoveryAuditIndexReceipt.create({ data: { runId: run.id, platform: 'lever', pattern: 'jobs.lever.co/*', indexId: 'fixture-index', pagesRead: 1, recordsRead: 7, candidatesQueued: 7 } });
  const originals = ['success-a', 'success-b', 'failed', 'future', 'retired'].map(label => ({ runId: run.id,
    platform: 'lever', slug: `${prefix}-${label}`, normalizedSlug: `${prefix}-${label}`, status: 'unresolved', attempts: 5,
    lastError: 'HTTP 429', nextAttemptAt: label === 'future' ? future : past }));
  await db.atsDiscoveryAuditCandidate.createMany({ data: [...originals,
    { ...originals[0], slug: originals[0].slug.toUpperCase() },
    { ...originals[0], platform: 'workday', slug: 'not.a.tenant.wd3::robots.txt', normalizedSlug: 'not.a.tenant.wd3::robots.txt' }] });
  await db.atsCompany.create({ data: { platform: 'lever', slug: `${prefix}-retired`, status: 'excluded', excludedReason: 'Operator retirement', checkDay: 1 } });
  const savedOriginals = await db.atsDiscoveryAuditCandidate.findMany({ where: { runId: run.id }, orderBy: [{ platform: 'asc' }, { slug: 'asc' }] });
  const job = await db.job.create({ data: { title: 'Protected fixture', company: 'Fixture', postedAt: past, status: 'interviewing', fitScore: 87 } });
  assert.equal(await catalogueDiscoveryRecovery(db), 5, 'case-only duplicates share recovery while retired boards remain outside it');
  assert.equal(await catalogueDiscoveryRecovery(db), 0, 'enrollment is idempotent');
  const calls: string[] = [];
  const validate = async (_platform: string, slug: string) => {
    calls.push(slug.toLowerCase());
    await new Promise(resolve => setTimeout(resolve, 10));
    return slug.endsWith('failed') ? { success: false, transient: true, reason: 'HTTP 503' } : { success: true, jobsFound: 3 };
  };
  const passes = await Promise.all([1, 2].map(() => runDiscoveryRecovery(db, { limit: 2, validate })));
  assert.equal(passes.reduce((n, pass) => n + pass.attempted, 0), 4);
  assert.equal(calls.length, 3, 'malformed identity consumes no provider request');
  assert.equal(new Set(calls).size, calls.length, 'concurrent passes cannot validate one identity twice');
  assert(!calls.some(slug => slug.endsWith('future') || slug.endsWith('retired')));
  const retry = await db.atsDiscoveryValidationRecovery.findUniqueOrThrow({ where: { platform_normalizedSlug: { platform: 'lever', normalizedSlug: `${prefix}-failed` } } });
  assert.equal(retry.state, 'retry'); assert.equal(retry.leaseToken, null); assert(retry.nextAttemptAt > new Date());
  assert.equal((await db.atsDiscoveryValidationRecovery.findUniqueOrThrow({ where: { platform_normalizedSlug: { platform: 'lever', normalizedSlug: `${prefix}-future` } } })).nextAttemptAt.getTime(), future.getTime());
  assert.equal(await db.atsCompany.count({ where: { platform: 'workday', slug: 'not.a.tenant.wd3::robots.txt' } }), 0);
  assert.equal((await discoveryRecoverySnapshot(db)).review, 1);

  const leased = async (suffix: string, platform = 'lever', expires = future) => db.atsDiscoveryValidationRecovery.create({ data: {
    platform, slug: `${prefix}-${suffix}`, normalizedSlug: `${prefix}-${suffix}`, sourceRunId: run.id,
    nextAttemptAt: past, state: 'pending', leaseToken: randomUUID(), leaseExpiresAt: expires,
  } });
  const stale = await leased('stale', 'lever', past);
  assert.equal(await recoverDiscoveryCandidate(db, { ...stale, leaseToken: stale.leaseToken! }, validate), 'lease_lost');
  assert.equal(await db.atsCompany.count({ where: { slug: stale.slug } }), 0, 'stale completion cannot create a board');
  const live = await leased('live');
  const reclaimed = await runDiscoveryRecovery(db, { limit: 1, validate });
  assert.equal(reclaimed.attempted, 1, 'expired worker lease is reclaimable');
  assert.equal((await db.atsDiscoveryValidationRecovery.findUniqueOrThrow({ where: { platform_normalizedSlug: { platform: live.platform, normalizedSlug: live.normalizedSlug } } })).leaseToken, live.leaseToken, 'live peer lease survives');

  const raced = await leased('retirement-race');
  assert.equal(await recoverDiscoveryCandidate(db, { ...raced, leaseToken: raced.leaseToken! }, async () => {
    await db.atsCompany.create({ data: { platform: raced.platform, slug: raced.slug, status: 'excluded', excludedReason: 'Operator retirement during validation', checkDay: 1 } });
    return { success: true, jobsFound: 3 };
  }), 'retired');
  const admission = await leased('admission-race', 'gem');
  const proxy = new Proxy(db, { get(target, property) {
    if (property === '$transaction') return async (work: Parameters<typeof db.$transaction>[0], options: unknown) => {
      await db.atsCompany.create({ data: { platform: 'gem', slug: admission.slug, status: 'excluded', excludedReason: 'Operator retirement', checkDay: 1 } });
      return (target.$transaction as (...args: unknown[]) => Promise<unknown>)(work, options);
    };
    return Reflect.get(target, property);
  } });
  assert.equal(await recoverDiscoveryCandidate(proxy, { ...admission, leaseToken: admission.leaseToken! }, validate), 'retired');
  assert.equal(await db.atsFirstCollectionCandidate.count({ where: { slug: admission.slug } }), 0, 'retirement wins the admission race');

  await db.pipelineState.upsert({ where: { id: 'global' }, create: { id: 'global', schedulePaused: true }, update: { schedulePaused: true, pausedUntil: null } });
  assert.equal((await runDiscoveryRecovery(db, { validate })).attempted, 0, 'indefinite operator pause wins');
  await db.pipelineState.update({ where: { id: 'global' }, data: { schedulePaused: false } });
  assert.equal((await runDiscoveryRecovery(db, { validate, allows: () => false })).attempted, 0, 'storage pressure wins');
  assert.deepEqual(await db.atsDiscoveryAuditCandidate.findMany({ where: { runId: run.id }, orderBy: [{ platform: 'asc' }, { slug: 'asc' }] }), savedOriginals);
  assert.deepEqual(await db.atsDiscoveryAuditIndexReceipt.findUnique({ where: { id: receipt.id } }), receipt);
  assert.deepEqual(await db.job.findUnique({ where: { id: job.id } }), job, 'human lifecycle and scores remain byte-for-byte unchanged');
  console.log('Discovery recovery: durable deduplication, bounded concurrent claims, future holds, lease expiry/fencing, malformed identities, both retirement races, operator/storage pauses, and original evidence/job preservation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
