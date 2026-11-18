import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { prisma } from './prisma';
import { controlPrisma } from './controlPrisma';
import { Prisma } from './prismaClient';

export const ATS_DISTRIBUTED_WORKER_VERSION = 1;
/**
 * Release B runs every ATS acquisition lane on the Mac. The Pi keeps paid
 * searches and Careerforce and still hosts PostgreSQL, so this reserve is now
 * a configurable floor rather than the fixed four lanes Release A required.
 * Zero means the Pi claims no ATS acquisition capacity at all.
 */
export const ATS_PI_LOCAL_SLOT_RESERVE = 0;
export const ATS_DISTRIBUTED_WORKERS_ENABLED = ['1', 'true'].includes(
  String(process.env.ATS_DISTRIBUTED_WORKERS_ENABLED || '').trim().toLowerCase(),
);
export const ATS_WORKER_SLOT_LEASE_MS = 3 * 60_000;
export const ATS_WORKER_SLOT_HEARTBEAT_MS = 30_000;

export type AtsAdmissionState = 'open' | 'draining';
export type AtsWorkerKind = 'pi-acquisition' | 'mac-continuation';

export type AtsCoordinationGate = {
  admissionState: string;
  admissionResumeAt: Date | null;
  drainRequestedAt: Date | null;
  cutoverReadyAt: Date | null;
  distributedAuthorityActivatedAt: Date | null;
  distributedWriterVersion: number;
  remoteWorkersEnabled: boolean;
  globalSlotLimit: number;
  localSlotReserve: number;
};

export type AtsWorkerSlotLease = {
  slotNumber: number;
  leaseOwner: string;
  leaseToken: string;
  leaseFence: bigint;
  workerKind: AtsWorkerKind;
  releaseId: string;
  leaseExpiresAt: Date;
};

export function validateAtsCoordinationGate(
  gate: AtsCoordinationGate | null,
  options: { requireDistributed?: boolean; requireRemote?: boolean } = {},
): { valid: true } | { valid: false; reason: string } {
  if (!gate) return { valid: false, reason: 'ATS acquisition coordination gate is missing.' };
  if (gate.admissionState !== 'open' && gate.admissionState !== 'draining') {
    return { valid: false, reason: `Unknown ATS admission state ${gate.admissionState}.` };
  }
  if (gate.localSlotReserve < 0
    || gate.globalSlotLimit < gate.localSlotReserve
    || gate.globalSlotLimit < 1
    || gate.globalSlotLimit > 8) {
    return {
      valid: false,
      reason: 'ATS Release B requires a non-negative Pi reserve and 1-8 global slots.',
    };
  }
  if (options.requireDistributed) {
    if (!gate.cutoverReadyAt) {
      return { valid: false, reason: 'Distributed ATS work requires a recorded clean-cutover boundary.' };
    }
    if (!gate.distributedAuthorityActivatedAt
      || gate.distributedWriterVersion < ATS_DISTRIBUTED_WORKER_VERSION) {
      return {
        valid: false,
        reason: `Distributed ATS work requires durable worker version ${ATS_DISTRIBUTED_WORKER_VERSION}.`,
      };
    }
  }
  if (options.requireRemote && !gate.remoteWorkersEnabled) {
    return { valid: false, reason: 'Remote ATS workers are not enabled by the durable gate.' };
  }
  return { valid: true };
}

export async function readAtsCoordinationGate(): Promise<AtsCoordinationGate | null> {
  return prisma.atsAcquisitionRuntimeGate.findUnique({
    where: { id: 'global' },
    select: {
      admissionState: true,
      admissionResumeAt: true,
      drainRequestedAt: true,
      cutoverReadyAt: true,
      distributedAuthorityActivatedAt: true,
      distributedWriterVersion: true,
      remoteWorkersEnabled: true,
      globalSlotLimit: true,
      localSlotReserve: true,
    },
  });
}

export async function atsNewBoardAdmissionsAllowed(now = new Date()): Promise<boolean> {
  await prisma.atsAcquisitionRuntimeGate.updateMany({
    where: {
      id: 'global',
      admissionState: 'draining',
      admissionResumeAt: { lte: now },
    },
    data: {
      admissionState: 'open',
      admissionResumeAt: null,
      drainRequestedAt: null,
    },
  });
  const gate = await readAtsCoordinationGate();
  const validation = validateAtsCoordinationGate(gate);
  if (!validation.valid) throw new Error(validation.reason);
  return gate?.admissionState === 'open';
}

export async function atsDistributedArchitectureActive(): Promise<boolean> {
  if (!ATS_DISTRIBUTED_WORKERS_ENABLED) return false;
  const gate = await readAtsCoordinationGate();
  return validateAtsCoordinationGate(gate, { requireDistributed: true }).valid;
}

function slotOwner(workerKind: AtsWorkerKind): string {
  return `${workerKind}:${os.hostname()}:${process.pid}`;
}

export async function claimAtsWorkerSlots(input: {
  workerKind: AtsWorkerKind;
  count: number;
  now?: Date;
  releaseId?: string;
}): Promise<AtsWorkerSlotLease[]> {
  if (!ATS_DISTRIBUTED_WORKERS_ENABLED) return [];
  const now = input.now || new Date();
  const gate = await readAtsCoordinationGate();
  const remote = input.workerKind === 'mac-continuation';
  const validation = validateAtsCoordinationGate(gate, {
    requireDistributed: true,
    requireRemote: remote,
  });
  if (!validation.valid) throw new Error(validation.reason);
  if (!gate) throw new Error('ATS acquisition coordination gate disappeared during slot claim.');
  const releaseId = input.releaseId || process.env.ATS_WORKER_RELEASE_ID || '';
  if (!/^[a-f0-9]{40}$/i.test(releaseId)) {
    throw new Error('Distributed ATS capacity requires the exact 40-character deployed Git release ID.');
  }

  if (remote && gate.localSlotReserve > 0) {
    // While the Pi still reserves lanes, an already-running Pi child from
    // before distributed activation holds no slot leases. Refuse remote work
    // until a compatible Pi child has restarted and visibly fenced all of its
    // existing lanes into the global budget. At a zero reserve the Pi claims
    // no ATS capacity at all, so there is no Pi lease left to coordinate with.
    const coordinatedPiSlots = await prisma.atsAcquisitionWorkerSlot.count({
      where: {
        slotNumber: { gte: 1, lte: gate.localSlotReserve },
        workerKind: 'pi-acquisition',
        releaseId,
        leaseToken: { not: null },
        leaseExpiresAt: { gt: now },
      },
    });
    if (coordinatedPiSlots !== gate.localSlotReserve) {
      throw new Error(
        `Remote ATS work requires ${gate.localSlotReserve} healthy Pi capacity leases; observed ${coordinatedPiSlots}.`,
      );
    }
  }

  // Release A capped one worker at four slots because the Pi held the other
  // four. With the Mac owning every lane, the gate's own limit is the cap.
  const requested = Math.max(0, Math.min(gate.globalSlotLimit, Math.floor(input.count)));
  const firstSlot = remote ? gate.localSlotReserve + 1 : 1;
  const lastSlot = remote ? gate.globalSlotLimit : gate.localSlotReserve;
  const owner = slotOwner(input.workerKind);
  const leases: AtsWorkerSlotLease[] = [];
  for (let attempt = 0; attempt < requested * 4 && leases.length < requested; attempt++) {
    const candidate = await prisma.atsAcquisitionWorkerSlot.findFirst({
      where: {
        slotNumber: { gte: firstSlot, lte: lastSlot },
        OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: now } }],
      },
      orderBy: { slotNumber: 'asc' },
      select: { slotNumber: true },
    });
    if (!candidate) break;
    const token = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + ATS_WORKER_SLOT_LEASE_MS);
    const claimed = await prisma.atsAcquisitionWorkerSlot.updateMany({
      where: {
        slotNumber: candidate.slotNumber,
        OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        leaseOwner: owner,
        leaseToken: token,
        leaseFence: { increment: BigInt(1) },
        workerKind: input.workerKind,
        releaseId,
        acquiredAt: now,
        heartbeatAt: now,
        leaseExpiresAt,
      },
    });
    if (claimed.count !== 1) continue;
    const row = await prisma.atsAcquisitionWorkerSlot.findUniqueOrThrow({
      where: { slotNumber: candidate.slotNumber },
      select: { leaseFence: true },
    });
    leases.push({
      slotNumber: candidate.slotNumber,
      leaseOwner: owner,
      leaseToken: token,
      leaseFence: row.leaseFence,
      workerKind: input.workerKind,
      releaseId,
      leaseExpiresAt,
    });
  }
  return leases;
}

export async function heartbeatAtsWorkerSlots(
  leases: readonly AtsWorkerSlotLease[],
  now = new Date(),
): Promise<boolean> {
  if (leases.length === 0) return true;
  const leaseExpiresAt = new Date(now.getTime() + ATS_WORKER_SLOT_LEASE_MS);
  const ownedSlots = leases.map(lease =>
    Prisma.sql`(${lease.slotNumber}::int, ${lease.leaseToken}::text, ${lease.leaseFence}::bigint)`);
  // Lock the group before testing the database clock. A busy row can retry,
  // but an expired lease or a replacement owner must never be renewed.
  const renewed = await controlPrisma.$executeRaw(Prisma.sql`
    WITH owned AS MATERIALIZED (
      SELECT slot."slotNumber", slot."leaseExpiresAt"
      FROM "AtsAcquisitionWorkerSlot" slot
      JOIN (VALUES ${Prisma.join(ownedSlots)}) AS expected(number, token, fence)
        ON slot."slotNumber" = expected.number AND slot."leaseToken" = expected.token
          AND slot."leaseFence" = expected.fence
      ORDER BY slot."slotNumber" FOR NO KEY UPDATE OF slot NOWAIT
    )
    UPDATE "AtsAcquisitionWorkerSlot" slot
       SET "heartbeatAt" = (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
           "leaseExpiresAt" = (${leaseExpiresAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
           "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      FROM owned
     WHERE slot."slotNumber" = owned."slotNumber"
       AND (SELECT count(*) = ${leases.length} AND min("leaseExpiresAt") > (clock_timestamp() AT TIME ZONE 'UTC') FROM owned)
  `);
  return renewed === leases.length;
}

/** A failed checkout provides no new authority. Retry only inside the last
 * confirmed lease, with a separate expiry timer even if PostgreSQL hangs. */
export function maintainAtsWorkerSlots(
  leases: readonly AtsWorkerSlotLease[], signal: AbortSignal, onLost: (reason: Error) => void,
  renew = heartbeatAtsWorkerSlots,
): () => Promise<void> {
  if (leases.length === 0 || signal.aborted) return async () => {};
  let expiresAt = Math.min(...leases.map(lease => lease.leaseExpiresAt.getTime()));
  let stopped = false;
  let pending: Promise<void> | undefined;
  let nextBeat: ReturnType<typeof setTimeout>;
  let expiry: ReturnType<typeof setTimeout>;

  function cancel() {
    stopped = true;
    clearTimeout(nextBeat);
    clearTimeout(expiry);
  }
  function lose(message: string) {
    if (stopped || signal.aborted) return;
    cancel();
    onLost(new Error(message));
  }
  function expire() {
    lose('ATS worker slot renewal did not complete before the confirmed lease expired.');
  }
  function armExpiry() {
    clearTimeout(expiry);
    expiry = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
  }
  function schedule(delay: number) {
    nextBeat = setTimeout(() => { pending = beat(); }, delay);
  }
  async function beat() {
    if (stopped || signal.aborted) return;
    const started = new Date();
    if (started.getTime() >= expiresAt) return expire();
    try {
      const retained = await renew(leases, started);
      if (stopped || signal.aborted) return;
      if (!retained) return lose('ATS worker no longer owns its capacity leases.');
      if (Date.now() >= expiresAt) return expire();
      expiresAt = started.getTime() + ATS_WORKER_SLOT_LEASE_MS;
      armExpiry();
      schedule(ATS_WORKER_SLOT_HEARTBEAT_MS);
    } catch (error) {
      if (stopped || signal.aborted) return;
      if (Date.now() >= expiresAt) return expire();
      console.warn('ATS worker slot renewal failed. Retrying within the confirmed lease.', error instanceof Error ? error.message : String(error));
      schedule(5_000);
    }
  }

  signal.addEventListener('abort', cancel, { once: true });
  if (expiresAt <= Date.now()) expire();
  else {
    armExpiry();
    schedule(Math.min(ATS_WORKER_SLOT_HEARTBEAT_MS, (expiresAt - Date.now()) / 2));
  }
  return async () => {
    signal.removeEventListener('abort', cancel);
    cancel();
    await pending;
  };
}

export async function releaseAtsWorkerSlots(
  leases: readonly AtsWorkerSlotLease[],
): Promise<number> {
  let released = 0;
  for (const lease of leases) {
    const result = await prisma.atsAcquisitionWorkerSlot.updateMany({
      where: {
        slotNumber: lease.slotNumber,
        leaseToken: lease.leaseToken,
        leaseFence: lease.leaseFence,
      },
      data: {
        leaseOwner: null,
        leaseToken: null,
        workerKind: null,
        releaseId: null,
        acquiredAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
      },
    });
    released += result.count;
  }
  return released;
}
