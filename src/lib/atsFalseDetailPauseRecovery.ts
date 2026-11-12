import { Prisma, type PrismaClient } from './prismaClient';
import { recordJobPipelineEvent } from './ingestionControl';

const provider = 'ATS-homerun Details';
const knownErrors = ['Homerun detail changed posting identity or title', 'Homerun detail is incomplete'];

/** Explicit operational recovery for the exact parser failure repaired in this
 * release. No terminal item, raw evidence, job, score or operator hold is edited. */
export async function recoverFalseHomerunDetailPause(client: Pick<PrismaClient, '$transaction'>, apply = false, now = new Date()) {
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT provider FROM "ProviderCircuit" WHERE provider=${provider} FOR UPDATE`;
    const before = await tx.providerCircuit.findUnique({ where: { provider } });
    if (!before || before.state !== 'open' || !before.openUntil || !knownErrors.includes(before.lastError || '')) {
      return { apply, outcome: 'no_matching_false_pause', releasedItems: 0, releasedBatches: 0 };
    }
    const nowUtc = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    const pauseUtc = Prisma.sql`(${before.openUntil.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    const error = `ATS-homerun detail enrichment deferred by the platform circuit until ${before.openUntil.toISOString()}`;
    const eligibility = Prisma.sql`
      batch.platform='homerun' AND batch."writerMode"='v2' AND batch.status IN ('fetching','partial')
      AND board.status='active' AND board."firstCollectionHoldReason" IS NULL
      AND (batch."acquisitionClaimToken" IS NULL OR batch."acquisitionLeaseExpiresAt" <= ${nowUtc})
      AND item."ledgerGeneration"=batch."activeLedgerGeneration" AND item."enrichmentStatus"='pending'
      AND item."retryCode"='provider_unavailable' AND item."retryScope"='provider'
      AND item."nextDetailAt"=${pauseUtc} AND item."detailError"=${error}
      AND (item."itemClaimToken" IS NULL OR item."itemLeaseExpiresAt" <= ${nowUtc})`;
    const selected = await tx.$queryRaw<Array<{ id: string; batchId: string }>>(Prisma.sql`
      SELECT item.id,item."batchId" FROM "AtsIngestionItem" item
      JOIN "AtsIngestionBatch" batch ON batch.id=item."batchId"
      JOIN "AtsCompany" board ON board.platform=batch.platform AND board.slug=batch.slug
      WHERE ${eligibility}
      FOR UPDATE OF item,batch
    `);
    const priorPause = { provider, state: before.state, openUntil: before.openUntil.toISOString(), lastError: before.lastError,
      consecutiveFailures: before.consecutiveFailures, lastFailureAt: before.lastFailureAt?.toISOString() || null };
    if (!apply) return { apply, outcome: 'preview', priorPause, eligibleItems: selected.length,
      eligibleBatches: new Set(selected.map(item => item.batchId)).size };
    await tx.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
    await tx.providerCircuit.update({ where: { provider }, data: {
      state: 'closed', openUntil: null, consecutiveFailures: 0, lastError: null,
    } });
    const moved = selected.length ? await tx.$queryRaw<Array<{ id: string; batchId: string }>>(Prisma.sql`
      UPDATE "AtsIngestionItem" item SET "nextDetailAt"=${nowUtc},"updatedAt"=${nowUtc}
      FROM "AtsIngestionBatch" batch JOIN "AtsCompany" board ON board.platform=batch.platform AND board.slug=batch.slug
      WHERE batch.id=item."batchId" AND item.id IN (${Prisma.join(selected.map(item => item.id))}) AND ${eligibility}
      RETURNING item.id,item."batchId"
    `) : [];
    const batchIds = [...new Set(moved.map(item => item.batchId))];
    const changed = batchIds.length ? await tx.atsIngestionBatch.updateMany({ where: {
      id: { in: batchIds }, status: { in: ['fetching', 'partial'] }, nextAcquireAt: before.openUntil,
      OR: [{ acquisitionClaimToken: null }, { acquisitionLeaseExpiresAt: { lte: now } }],
    }, data: { nextAcquireAt: now } }) : { count: 0 };
    const result = { apply, outcome: 'recovered', priorPause, releasedItems: moved.length, releasedBatches: changed.count };
    await recordJobPipelineEvent({ eventType: 'ats_false_detail_pause_repaired', stage: 'ats_acquisition', source: provider,
      identityParts: [before.openUntil.toISOString(), before.lastFailureAt?.toISOString() || 'unknown'], details: result }, tx);
    return result;
  }, { timeout: 30_000 });
}
