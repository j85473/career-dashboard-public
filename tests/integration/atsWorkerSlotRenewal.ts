/** Run against a disposable loopback database prepared with the current schema. */
import assert from 'node:assert/strict';
import { heartbeatAtsWorkerSlots, type AtsWorkerSlotLease } from '../../src/lib/atsAcquisitionCoordination';
import { controlPrisma } from '../../src/lib/controlPrisma';
import { DATA_DATABASE_CONNECTION_LIMIT } from '../../src/lib/databaseUrl';
import { prisma } from '../../src/lib/prisma';

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.equal(process.env.DATABASE_RUNTIME_HOST || url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/ats_lease_renewal_test_clean');
  const now = new Date();
  const leases: AtsWorkerSlotLease[] = Array.from({ length: 8 }, (_, i) => ({
    slotNumber: i + 1, leaseOwner: 'fixture', leaseToken: String(i), leaseFence: BigInt(7),
    workerKind: 'mac-continuation', releaseId: 'fixture', leaseExpiresAt: new Date(+now + 60000),
  }));
  await prisma.atsAcquisitionWorkerSlot.createMany({
    data: leases.map(lease => ({ ...lease, acquiredAt: now, heartbeatAt: now })),
  });

  const busy = Array.from({ length: DATA_DATABASE_CONNECTION_LIMIT }, () => Promise.withResolvers<void>());
  const release = Promise.withResolvers<void>();
  const transactions = busy.map(ready => prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1`;
    ready.resolve();
    await release.promise;
  }, { timeout: 12000 }));
  try {
    await Promise.all(busy.map(ready => ready.promise));
    assert.equal(await heartbeatAtsWorkerSlots(leases, now), true);
  } finally {
    release.resolve();
    await Promise.all(transactions);
  }
  const rows = () => prisma.atsAcquisitionWorkerSlot.findMany({ orderBy: { slotNumber: 'asc' } });
  assert.ok((await rows()).every(row => row.leaseExpiresAt?.getTime() === +now + 180000));

  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "slotNumber" FROM "AtsAcquisitionWorkerSlot" WHERE "slotNumber" = 3 FOR UPDATE`;
    await assert.rejects(heartbeatAtsWorkerSlots(leases), /lock|55P03/i);
  });
  assert.equal(await heartbeatAtsWorkerSlots(leases), true);

  // A live replacement and an expired original both invalidate the group.
  for (const data of [{ leaseFence: BigInt(8) }, { leaseFence: BigInt(7), leaseExpiresAt: new Date(0) }]) {
    await prisma.atsAcquisitionWorkerSlot.update({ where: { slotNumber: 4 }, data });
    const before = await rows();
    assert.equal(await heartbeatAtsWorkerSlots(leases), false);
    assert.deepEqual(await rows(), before);
  }
  console.log('Eight-slot renewal passed under data-pool saturation, row contention, ownership loss and expiry.');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => Promise.all([prisma.$disconnect(), controlPrisma.$disconnect()]));
