import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from './prismaClient';
import { isPermanentAtsBoardRetirement, recordDiscoveredAtsBoard } from './atsBoardDiscovery';
import { isFirstCollectionPlatform } from './atsFirstCollectionAdmission';
import { browserAtsBoardFromUrl, isBrowserAtsPlatform } from './browserAtsBoards';
import { publicAtsBoardUrl, isPublicAtsPlatform } from './publicAtsBoards';
import { eightfoldBoardIdentity } from './eightfoldBoard';
import { storageAllows } from './storagePressure';
import { reserveProviderRequest } from './ingestionControl';
import { fetchAtsPlatformResponse } from './atsProviderRequest';
import { safeExternalFetch } from './safeExternalFetch';
import { assertAtsServiceAvailable } from './atsTemporaryFailure';
import { validateSlug, PLATFORMS } from '../scripts/discoverATS';

const DAY = 86_400_000;
export const DISCOVERY_RECOVERY_INTERVAL_MS = 5 * 60_000;
type Client = PrismaClient;
const utc = (value: Date) => Prisma.sql`(${value.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
export async function discoveryRecoveryAllowed(client: Pick<Client, 'pipelineState'>, now = new Date()): Promise<boolean> {
  if (!storageAllows('collection')) return false;
  const operator = await client.pipelineState.findUnique({ where: { id: 'global' }, select: { schedulePaused: true, pausedUntil: true } });
  return !operator?.schedulePaused || !!operator.pausedUntil && operator.pausedUntil <= now;
}
export type DiscoveryRecoveryCandidate = {
  platform: string; normalizedSlug: string; slug: string; sourceRunId: string;
  attempts: number; leaseToken: string;
};
export type DiscoveryRecoveryValidation = {
  success: boolean; jobsFound?: number; browserPending?: boolean; transient?: boolean;
  reason?: string; retryAt?: Date;
  deferred?: boolean;
};

/** The scanner already owns discovery.lock, so it must service recovery itself
 * while external timer passes yield. One bounded pass earns each interval;
 * repeated checkpoints share an in-flight pass and never accumulate catch-up work. */
export function createDiscoveryRecoveryCadence<T>(run: () => Promise<T>, options: {
  now?: () => number; signal?: AbortSignal; intervalMs?: number;
} = {}): () => Promise<T | undefined> {
  const now = options.now || Date.now;
  const intervalMs = options.intervalMs ?? DISCOVERY_RECOVERY_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw Error('Invalid discovery recovery interval');
  let nextEligibleAt = 0;
  let inFlight: Promise<T> | null = null;
  return () => {
    if (options.signal?.aborted) return Promise.resolve(undefined);
    if (inFlight) return inFlight;
    const at = now();
    if (at < nextEligibleAt) return Promise.resolve(undefined);
    nextEligibleAt = at + intervalMs;
    inFlight = Promise.resolve().then(run).finally(() => { inFlight = null; });
    return inFlight;
  };
}

/** Do not spend provider capacity on archived asset URLs or malformed tenants. */
export function validDiscoveryRecoveryIdentity(platform: string, slug: string): boolean {
  if (!Object.hasOwn(PLATFORMS, platform) || !slug || slug.length > 1024 || /[\x00-\x20\x7f]/.test(slug)) return false;
  try {
    if (isBrowserAtsPlatform(platform)) return browserAtsBoardFromUrl(platform, slug) === slug;
    if (isPublicAtsPlatform(platform)) { publicAtsBoardUrl(platform, slug); return true; }
    if (platform === 'eightfold') { eightfoldBoardIdentity(slug); return true; }
    if (platform === 'workday') return /^[a-z0-9-]+(?:\.wd\d+)?::[a-z0-9_-]+$/i.test(slug)
      && !/::(?:robots|sitemap|assets|favicon)$/i.test(slug);
    if (platform === 'gusto') return /^[a-z0-9_-]+$/i.test(slug);
    return /^[a-z0-9_-]+$/i.test(slug) && !/^(?:robots|sitemap|assets|favicon|api|www)$/i.test(slug);
  } catch { return false; }
}

/** Immutable audit outcomes stay intact. One exact spelling owns each recovery identity. */
export async function catalogueDiscoveryRecovery(client: Client, maximum = 500): Promise<number> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) throw Error('Invalid discovery recovery catalogue bound');
  return client.$executeRaw(Prisma.sql`
    WITH candidates AS (
      SELECT DISTINCT ON (platform,lower(slug)) platform,slug,"runId","lastError",
        MAX("nextAttemptAt") OVER (PARTITION BY platform,lower(slug)) AS "nextAttemptAt"
      FROM "AtsDiscoveryAuditCandidate" WHERE status='unresolved'
      ORDER BY platform,lower(slug),"updatedAt" DESC,slug
    )
    INSERT INTO "AtsDiscoveryValidationRecovery"
      (platform,"normalizedSlug",slug,"sourceRunId","lastError","nextAttemptAt","updatedAt")
    SELECT c.platform,lower(c.slug),c.slug,c."runId",c."lastError",c."nextAttemptAt",CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    FROM candidates c
    WHERE NOT EXISTS (SELECT 1 FROM "AtsCompany" b WHERE b.platform=c.platform AND lower(b.slug)=lower(c.slug))
      AND NOT EXISTS (SELECT 1 FROM "AtsFirstCollectionCandidate" f WHERE f.platform=c.platform AND lower(f.slug)=lower(c.slug))
      AND NOT EXISTS (SELECT 1 FROM "AtsDiscoveryValidationRecovery" r WHERE r.platform=c.platform AND r."normalizedSlug"=lower(c.slug))
    ORDER BY c."nextAttemptAt",c.platform,c.slug LIMIT ${maximum}
    ON CONFLICT (platform,"normalizedSlug") DO NOTHING
  `);
}

export function discoveryRecoveryOutcome(validation: DiscoveryRecoveryValidation, attempts: number, now: Date) {
  if (validation.deferred) return { state: 'retry', nextAttemptAt: new Date(Math.max(now.getTime() + 5 * 60_000, validation.retryAt?.getTime() || 0)),
    lastError: validation.reason || 'Waiting for provider or storage capacity' };
  if (validation.browserPending || validation.success && Number.isSafeInteger(validation.jobsFound) && validation.jobsFound! >= 0) {
    return { state: 'resolved', nextAttemptAt: now, lastError: null };
  }
  // Retries are bounded and visible. Exhausted recovery becomes review work;
  // it never retires the employer or edits its historical discovery outcome.
  const state = attempts >= 8 ? 'review' : 'retry';
  const days = /\b(?:404|410)\b/.test(validation.reason || '') ? 30
    : validation.reason === 'No jobs listed' ? 7 : Math.min(30, 2 ** Math.min(attempts - 1, 5));
  return { state, nextAttemptAt: new Date(Math.max(now.getTime() + days * DAY, validation.retryAt?.getTime() || 0)),
    lastError: validation.reason || 'Public board validation remains inconclusive' };
}

async function validateWithProviderCapacity(client: Client, platform: string, slug: string, signal: AbortSignal): Promise<DiscoveryRecoveryValidation> {
  let heldUntil: Date | undefined;
  let deferred = false;
  const result = await validateSlug(platform as keyof typeof PLATFORMS, slug, 5 * 1024 * 1024, async (url, init) => {
    if (!await discoveryRecoveryAllowed(client)) { deferred = true; throw Error('Discovery paused by operator or storage control'); }
    const budget = await reserveProviderRequest({ provider: `ATS-${platform}` });
    if (!budget.allowed) { deferred = true; heldUntil = budget.retryAt; throw Error('Provider cooldown'); }
    const requestSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
    return fetchAtsPlatformResponse(platform, requestSignal,
      () => safeExternalFetch(url, { ...init, signal: requestSignal }, 5, { maximumBytes: 5 * 1024 * 1024 }),
      { requestedUrl: url, boardSlug: slug, onResponse: response => assertAtsServiceAvailable(platform, response) });
  });
  return { ...result, deferred: deferred || signal.aborted, ...(heldUntil ? { retryAt: heldUntil } : {}) };
}

export async function recoverDiscoveryCandidate(client: Client, candidate: DiscoveryRecoveryCandidate,
  validate?: (platform: string, slug: string, signal: AbortSignal) => Promise<DiscoveryRecoveryValidation>,
  signal: AbortSignal = AbortSignal.timeout(60_000)) {
  const identity = { platform: candidate.platform, normalizedSlug: candidate.normalizedSlug };
  const existing = await client.atsCompany.findMany({ where: { platform: candidate.platform,
    slug: { equals: candidate.slug, mode: 'insensitive' } }, select: { status: true } });
  const enrolled = await client.atsFirstCollectionCandidate.findFirst({ where: {
    platform: candidate.platform, slug: { equals: candidate.slug, mode: 'insensitive' },
  }, select: { state: true } });
  let validation: DiscoveryRecoveryValidation = { success: false };
  let terminal: string | null = existing.length ? existing.every(board => board.status === 'excluded') ? 'retired' : 'existing'
    : enrolled ? 'existing' : !validDiscoveryRecoveryIdentity(candidate.platform, candidate.slug) ? 'review' : null;
  if (!terminal && isFirstCollectionPlatform(candidate.platform)) {
    // A provider added since the old audit belongs to normal controlled admission.
    terminal = 'admission';
  } else if (!terminal) {
    try { validation = await (validate || ((platform, slug, requestSignal) => validateWithProviderCapacity(client, platform, slug, requestSignal)))(candidate.platform, candidate.slug, signal); }
    catch { validation = { success: false, transient: true, deferred: signal.aborted,
      reason: signal.aborted ? 'Validation interrupted; retained for retry' : 'Public board validation failed' }; }
  }
  const finishedAt = new Date();
  return client.$transaction(async tx => {
    const [owned] = await tx.$queryRaw<Array<{ nextAttemptAt: Date }>>(Prisma.sql`
      SELECT "nextAttemptAt" FROM "AtsDiscoveryValidationRecovery"
      WHERE platform=${candidate.platform} AND "normalizedSlug"=${candidate.normalizedSlug}
        AND "leaseToken"=${candidate.leaseToken} AND "leaseExpiresAt">${utc(finishedAt)} AND state='pending'
      FOR UPDATE
    `);
    if (!owned) return 'lease_lost';
    const attempts = candidate.attempts + (terminal || validation.deferred ? 0 : 1);
    const outcome = terminal ? { state: terminal, nextAttemptAt: owned.nextAttemptAt,
      lastError: terminal === 'review' ? 'Saved identity needs review before a provider request' : null }
      : discoveryRecoveryOutcome(validation, attempts, finishedAt);
    if (terminal === 'admission') {
      const lockIdentity = JSON.stringify([candidate.platform, candidate.slug.toLocaleLowerCase('en-US')]);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity},0))`;
      const boards = await tx.atsCompany.findMany({ where: { platform: candidate.platform,
        slug: { equals: candidate.slug, mode: 'insensitive' } }, select: { status: true, excludedReason: true } });
      if (boards.some(isPermanentAtsBoardRetirement) || boards.length && boards.every(board => board.status === 'excluded')) outcome.state = 'retired';
      else {
        if (!boards.length) await tx.atsFirstCollectionCandidate.createMany({ data: [{ platform: candidate.platform, slug: candidate.slug,
          discoveryRunId: candidate.sourceRunId }], skipDuplicates: true });
        outcome.state = 'existing';
      }
    } else if (outcome.state === 'resolved') {
      // Rechecks retirement under the existing board advisory lock at commit.
      outcome.state = await recordDiscoveredAtsBoard(tx, { platform: candidate.platform, slug: candidate.slug }, finishedAt, {
        status: validation.browserPending ? 'parked' : 'active', browserPending: validation.browserPending,
        jobsFound: validation.jobsFound || 0, reactivateExisting: false,
      });
      if (outcome.state === 'created') outcome.state = 'resolved';
    }
    await tx.atsDiscoveryValidationRecovery.updateMany({ where: { ...identity, leaseToken: candidate.leaseToken, state: 'pending' },
      data: { ...outcome, attempts, leaseToken: null, leaseExpiresAt: null,
        resolvedAt: ['resolved', 'existing', 'retired'].includes(outcome.state) ? finishedAt : null } });
    return outcome.state;
  }, { timeout: 30_000 });
}

/** At most twenty sequential validations per invocation. No source-index requests. */
export async function runDiscoveryRecovery(client: Client, options: {
  limit?: number; durationMs?: number; signal?: AbortSignal; allows?: () => boolean | Promise<boolean>;
  validate?: Parameters<typeof recoverDiscoveryCandidate>[2];
} = {}) {
  const limit = options.limit ?? 20, durationMs = options.durationMs ?? 120_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 180_000) throw Error('Invalid discovery recovery bounds');
  const allows = options.allows || (() => discoveryRecoveryAllowed(client));
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(durationMs)]) : AbortSignal.timeout(durationMs);
  if (!await allows() || signal.aborted) return { catalogued: 0, attempted: 0, outcomes: {} };
  const catalogued = await catalogueDiscoveryRecovery(client);
  const outcomes: Record<string, number> = {};
  let attempted = 0;
  while (attempted < limit && !signal.aborted && await allows()) {
    const token = randomUUID(), now = new Date();
    const [candidate] = await client.$queryRaw<DiscoveryRecoveryCandidate[]>(Prisma.sql`
      WITH next AS (
        SELECT platform,"normalizedSlug" FROM "AtsDiscoveryValidationRecovery"
        WHERE state IN ('pending','retry') AND "nextAttemptAt"<=${utc(now)}
          AND ("leaseToken" IS NULL OR "leaseExpiresAt"<=${utc(now)})
        ORDER BY "nextAttemptAt",attempts,platform,"normalizedSlug" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "AtsDiscoveryValidationRecovery" r SET state='pending',"leaseToken"=${token},
        "leaseExpiresAt"=${utc(new Date(now.getTime() + 3 * 60_000))},"updatedAt"=${utc(now)}
      FROM next WHERE r.platform=next.platform AND r."normalizedSlug"=next."normalizedSlug" RETURNING r.*
    `);
    if (!candidate) break;
    const outcome = await recoverDiscoveryCandidate(client, candidate, options.validate,
      AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
    attempted++;
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
  }
  return { catalogued, attempted, outcomes };
}

export async function discoveryRecoverySnapshot(client: Client, now = new Date()) {
  const [row] = await client.$queryRaw<Array<{ pending: bigint; held: bigint; review: bigint; recovered: bigint; unqueued: bigint }>>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE state IN ('pending','retry') AND "nextAttemptAt"<=${utc(now)})::bigint AS pending,
      COUNT(*) FILTER (WHERE state IN ('pending','retry') AND "nextAttemptAt">${utc(now)})::bigint AS held,
      COUNT(*) FILTER (WHERE state='review')::bigint AS review,
      COUNT(*) FILTER (WHERE state IN ('resolved','existing','retired'))::bigint AS recovered,
      (SELECT COUNT(*) FROM (
        SELECT DISTINCT c.platform,lower(c.slug) FROM "AtsDiscoveryAuditCandidate" c WHERE c.status='unresolved'
          AND NOT EXISTS (SELECT 1 FROM "AtsCompany" b WHERE b.platform=c.platform AND lower(b.slug)=lower(c.slug))
          AND NOT EXISTS (SELECT 1 FROM "AtsFirstCollectionCandidate" f WHERE f.platform=c.platform AND lower(f.slug)=lower(c.slug))
          AND NOT EXISTS (SELECT 1 FROM "AtsDiscoveryValidationRecovery" r WHERE r.platform=c.platform AND r."normalizedSlug"=lower(c.slug))
      ) missing)::bigint AS unqueued
    FROM "AtsDiscoveryValidationRecovery"
  `);
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, Number(value)])) as {
    pending: number; held: number; review: number; recovered: number; unqueued: number;
  };
}
