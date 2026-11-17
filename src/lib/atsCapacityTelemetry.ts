import { prisma } from './prisma';
import { Prisma } from './prismaClient';
import { atsV2RuntimeLanePlan } from './atsAcquisitionDispatcherV2';
import { atsRunnableLegacyBatchSql, atsSegmentPersistenceCapacitySql } from './atsAdmissionCapacity';
import { readServiceState } from './atsServiceScheduling';
import { NON_API_ATS_PLATFORMS } from './browserAtsBoards';

export async function readAtsCapacityTelemetry(now = new Date()) {
  const gate = await prisma.atsAcquisitionRuntimeGate.findUnique({ where: { id: 'global' }, select: { globalSlotLimit: true } });
  const [plan, states, leases, working, capacity] = await Promise.all([
    atsV2RuntimeLanePlan(gate?.globalSlotLimit, now),
    prisma.atsSchedulerState.findMany(),
    prisma.atsPublicCapacityLease.findMany({ where: { leaseExpiresAt: { gt: now } } }),
    prisma.atsIngestionBatch.count({ where: { writerMode: 'v2', platform: { notIn: NON_API_ATS_PLATFORMS },
      acquisitionClaimToken: { not: null }, acquisitionLeaseExpiresAt: { gt: now } } }),
    prisma.$queryRaw<Array<{ jobs: bigint }>>(Prisma.sql`SELECT
      (COALESCE((${atsSegmentPersistenceCapacitySql(now)}),0) + COALESCE((SELECT SUM(GREATEST(batch."jobCount"-batch."processingOffset",0))
       FROM "AtsIngestionBatch" batch WHERE ${atsRunnableLegacyBatchSql(now)}),0))::bigint AS jobs`),
  ]);
  return {
    observedAt: now.toISOString(), newCollectionsReady: plan.coverageEligible || 0,
    listingTurnsReady: plan.listingEligible || 0, processingTurnsReady: plan.drainEligible || 0,
    workingBatches: working, persistenceCapacityJobs: Number(capacity[0]?.jobs || 0),
    publicReservedJobs: leases.reduce((sum, lease) => sum + lease.jobs, 0),
    policyReason: plan.reason, listingConcurrencyLimit: plan.listingConcurrencyLimit ?? null,
    resources: states.map(row => {
      const state = readServiceState(row.state);
      return { resource: row.resource, classes: Object.entries(state.classes).map(([key, value]) => ({
        key, serviceMs: value.serviceMs, turns: value.turns,
        lastSelectedAt: value.lastSelectedAt ? new Date(value.lastSelectedAt).toISOString() : null,
        activeTurns: Object.values(state.pending).filter(p => p.key === key && p.expiresAt > now.getTime()).length,
      })) };
    }),
  };
}
