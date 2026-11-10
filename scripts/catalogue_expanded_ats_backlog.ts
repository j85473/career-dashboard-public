import { prisma } from '../src/lib/prisma';
import { expandedBoardSlug, EXPANDED_PUBLIC_ATS, type ExpandedPublicAts } from '../src/lib/expandedPublicAts';
import { isPermanentAtsBoardRetirement } from '../src/lib/atsBoardDiscovery';

/** Move only the three implemented adapters' saved addresses into ordinary
 * validation. Existing first-collection holds and schedules are never reset. */
async function main() {
  const apply = process.argv.includes('--apply');
  const counts = { catalogued: 0, retired: 0, identityPending: 0, concurrent: 0 };
  let after: { runId: string; platform: string; slug: string } | undefined;
  for (;;) {
    const candidates = await prisma.atsDiscoveryAuditCandidate.findMany({
      where: { status: 'awaiting_adapter', platform: { in: [...EXPANDED_PUBLIC_ATS] } },
      orderBy: [{ runId: 'asc' }, { platform: 'asc' }, { slug: 'asc' }], take: 250,
      ...(after ? { cursor: { runId_platform_slug: after }, skip: 1 } : {}),
      select: { runId: true, platform: true, slug: true, sourceUrl: true },
    });
    if (!candidates.length) break;
    for (const candidate of candidates) {
      after = { runId: candidate.runId, platform: candidate.platform, slug: candidate.slug };
      const platform = candidate.platform as ExpandedPublicAts;
      const slug = expandedBoardSlug(platform, candidate.sourceUrl || candidate.slug);
      if (!apply) {
        counts[slug ? 'catalogued' : 'identityPending']++;
        continue;
      }
      const outcome = await prisma.$transaction(async tx => {
        const matches = slug ? await tx.atsCompany.findMany({ where: { platform, slug: { equals: slug, mode: 'insensitive' } },
          select: { status: true, excludedReason: true } }) : [];
        const retired = matches.some(isPermanentAtsBoardRetirement);
        const changed = await tx.atsDiscoveryAuditCandidate.updateMany({ where: { ...after!, status: 'awaiting_adapter' }, data: {
          status: !slug ? 'adapter_identity_pending' : retired ? 'retired' : 'discovered_waiting',
          lastError: slug ? null : 'Archived address needs a published canonical board identity',
        } });
        if (!changed.count) return 'concurrent' as const;
        if (!slug) return 'identityPending' as const;
        if (retired) return 'retired' as const;
        await tx.atsFirstCollectionCandidate.upsert({ where: { slug_platform: { slug, platform } },
          create: { slug, platform, sourceUrl: candidate.sourceUrl || candidate.slug, discoveryRunId: candidate.runId },
          update: {} });
        return 'catalogued' as const;
      });
      counts[outcome]++;
    }
  }
  console.log(JSON.stringify({ apply, ...counts, message: 'Candidates require normal employer validation and capacity admission before collection.' }, null, 2));
}

if (process.argv[1]?.includes('catalogue_expanded_ats_backlog')) main()
  .catch(() => { console.error('Expanded ATS backlog handoff failed; committed candidates remain durable.'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
