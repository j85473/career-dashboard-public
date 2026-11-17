import { Prisma, type PrismaClient } from './prismaClient';
import { atsRunnableLegacyBatchSql, atsSegmentPersistenceCapacitySql } from './atsAdmissionCapacity';
import { ATS_PUBLIC_TURN_JOBS, atsPersistenceAllocation } from './atsPersistenceAllocation';
import { storageAllows } from './storagePressure';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma';

/** Public crawlers persist bounded jobs directly; they do not append API
 * listing observations. Keep the operator gate and runnable writer pressure,
 * without charging them for another provider's unfinished catalogue. */
export async function publicCrawlCapacity(client: Pick<Prisma.TransactionClient, '$queryRaw'>, now = new Date()) {
    if (!storageAllows('collection')) return { healthy: false, persistence: 0, limit: 0 };
    const [snapshot] = await client.$queryRaw<Array<{ persistence: bigint; gate: string }>>(Prisma.sql`
        SELECT (COALESCE((${atsSegmentPersistenceCapacitySql(now)}),0)
          + COALESCE((SELECT SUM(GREATEST(batch."jobCount"-batch."processingOffset",0))
            FROM "AtsIngestionBatch" batch WHERE ${atsRunnableLegacyBatchSql(now)}),0))::bigint AS persistence,
          (SELECT "admissionState" FROM "AtsAcquisitionRuntimeGate" WHERE id='global') AS gate
    `);
    const setting = process.env.ATS_ACQUISITION_JOB_HIGH_WATERMARK?.trim();
    const configured = setting && /^[+-]?\d+$/.test(setting) ? Number(setting) : NaN;
    const limit = Number.isSafeInteger(configured) ? Math.max(100, Math.min(100000, configured)) : 2000;
    const persistence = Number(snapshot?.persistence || 0);
    // Reserve a full public-board turn, even though writes are sequential.
    return { healthy: !!snapshot && snapshot.gate === 'open' && persistence + ATS_PUBLIC_TURN_JOBS <= limit, persistence, limit };
}

export type PublicCrawlTurn = { resource: string; token: string };
export const PUBLIC_CRAWL_LEASE_MS = 90_000;

/** All HTTP groups and the licensed browser share the existing 100-job
 * allowance. A third collector waits instead of overspending that reserve. */
export async function reservePublicCrawlTurn(resource: string, now = new Date(), client: PrismaClient = prisma): Promise<PublicCrawlTurn | null> {
  if (!storageAllows('collection')) return null;
  return client.$transaction(async tx => {
    // Same lock as API publication; reservations cannot race a refill.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(912837465)`;
    const health = await publicCrawlCapacity(tx, now);
    if (!health.healthy) return null;
    const live = await tx.atsPublicCapacityLease.findMany({ where: { leaseExpiresAt: { gt: now } } });
    const reserved = live.reduce((sum, lease) => sum + lease.jobs, 0);
    if (live.some(lease => lease.resource === resource)) return null;
    const prior = await tx.atsPublicCapacityLease.findUnique({ where: { resource } });
    const freshSince = new Date(now.getTime() - 60_000);
    const requestedAt = prior && prior.updatedAt >= freshSince ? prior.requestedAt || now : now;
    // Keep waiting demand across the 15–20 second timer restarts. Fast HTTP
    // collectors cannot repeatedly reclaim both turns ahead of the browser.
    await tx.atsPublicCapacityLease.upsert({ where: { resource },
      create: { resource, token: randomUUID(), jobs: ATS_PUBLIC_TURN_JOBS, leaseExpiresAt: now, requestedAt, updatedAt: now },
      update: { token: randomUUID(), leaseExpiresAt: now, requestedAt, updatedAt: now } });
    const oldest = await tx.atsPublicCapacityLease.findFirst({
      where: { requestedAt: { not: null }, leaseExpiresAt: { lte: now }, updatedAt: { gte: freshSince } },
      orderBy: [{ requestedAt: 'asc' }, { resource: 'asc' }],
    });
    if (oldest?.resource !== resource
      || reserved + ATS_PUBLIC_TURN_JOBS > atsPersistenceAllocation(1000, health.limit).publicReserve
      || health.persistence + reserved + ATS_PUBLIC_TURN_JOBS > health.limit) return null;
    const token = randomUUID();
    await tx.atsPublicCapacityLease.upsert({ where: { resource },
      create: { resource, token, jobs: ATS_PUBLIC_TURN_JOBS, leaseExpiresAt: new Date(now.getTime() + PUBLIC_CRAWL_LEASE_MS) },
      update: { token, jobs: ATS_PUBLIC_TURN_JOBS, requestedAt: null, leaseExpiresAt: new Date(now.getTime() + PUBLIC_CRAWL_LEASE_MS) } });
    return { resource, token };
  }, { timeout: 10_000 });
}

export async function heartbeatPublicCrawlTurn(turn: PublicCrawlTurn, now = new Date(), client = prisma): Promise<boolean> {
  const updated = await client.atsPublicCapacityLease.updateMany({
    where: { resource: turn.resource, token: turn.token, leaseExpiresAt: { gt: now } },
    data: { leaseExpiresAt: new Date(now.getTime() + PUBLIC_CRAWL_LEASE_MS) },
  });
  return updated.count === 1;
}

export async function releasePublicCrawlTurn(turn: PublicCrawlTurn, client = prisma) {
  await client.atsPublicCapacityLease.deleteMany({ where: { resource: turn.resource, token: turn.token } });
}
