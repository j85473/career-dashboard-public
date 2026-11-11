import type { AtsFirstCollectionPolicy, Prisma } from './prismaClient';

/** A separate, explicit allowlist; the ordinary 250-job policy stays unchanged. */
export const REVIEWED_FIRST_COLLECTION_POLICY_ID = 'reviewed-oversized';
export const PROVIDER_BACKLOG_POLICY_ID = 'reviewed-provider-backlog';
export const REVIEWED_FIRST_COLLECTION_MAXIMUM_JOBS = 5000;
/** Explicit November 11 launch review. Other discovered boards keep ordinary admission. */
export const REVIEWED_PROVIDER_LAUNCH_BOARDS = [
  { platform: 'homerun', slug: 'jobs' },
  { platform: 'softgarden', slug: 'softgarden.softgarden.io' },
  { platform: 'dvinci', slug: 'adstec-karriere.dvinci-hr.com' },
  { platform: 'flatchr', slug: 'flatchr' },
] as const;
export const REVIEWED_PROVIDER_BACKLOG_PLATFORMS = ['homerun', 'softgarden', 'dvinci', 'flatchr'] as const;

export function reviewedFirstCollectionMaximumJobs(policy: AtsFirstCollectionPolicy,
  board: { platform: string; slug: string }): number {
  return (REVIEWED_PROVIDER_BACKLOG_PLATFORMS as readonly string[]).includes(board.platform)
    ? Math.min(250, policy.maxCatalogueJobs) : policy.maxCatalogueJobs;
}

export function reviewedFirstCollectionBoards(policy: AtsFirstCollectionPolicy | null): Array<{ platform: string; slug: string }> {
  if (!policy || ![REVIEWED_FIRST_COLLECTION_POLICY_ID, PROVIDER_BACKLOG_POLICY_ID].includes(policy.id) || policy.maxUnfinished !== 1
    || !['capacity', 'held'].includes(policy.mode)
    || (policy.id === PROVIDER_BACKLOG_POLICY_ID ? policy.maxCatalogueJobs !== 250 : policy.maxCatalogueJobs < 251 || policy.maxCatalogueJobs > 10000)
    || !Array.isArray(policy.pilotBoards) || !policy.pilotBoards.length || policy.pilotBoards.length > 100) return [];
  const boards: Array<{ platform: string; slug: string }> = [];
  for (const key of policy.pilotBoards) {
    if (typeof key !== 'string') return [];
    const split = key.indexOf('::');
    const platform = key.slice(0, split), slug = key.slice(split + 2);
    if (policy.id === PROVIDER_BACKLOG_POLICY_ID) {
      if (slug !== '*' || !(REVIEWED_PROVIDER_BACKLOG_PLATFORMS as readonly string[]).includes(platform)) return [];
    } else if (split < 1 || !(platform === 'clearcompany' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(slug)
      || platform === 'symphony' && ['hgv', 'victoriassecret'].includes(slug)
      || REVIEWED_PROVIDER_LAUNCH_BOARDS.some(board => board.platform === platform && board.slug === slug))) return [];
    if (!boards.some(board => board.platform === platform && board.slug === slug)) boards.push({ platform, slug });
  }
  return boards;
}

export function isReviewedFirstCollection(policy: AtsFirstCollectionPolicy | null, board: { platform: string; slug: string }): boolean {
  return reviewedFirstCollectionBoards(policy).some(value => value.platform === board.platform && (value.slug === board.slug || value.slug === '*'));
}

/** Wildcards are explicit operator enrollment, confined to these four providers.
 * They do not create boards or bypass canonical feed validation. */
export function reviewedProviderBacklogPlatforms(policy: AtsFirstCollectionPolicy | null): string[] {
  return reviewedFirstCollectionBoards(policy).filter(board => board.slug === '*').map(board => board.platform);
}

export function reviewedFirstCollectionWhere(policy: AtsFirstCollectionPolicy | null): Prisma.AtsCompanyWhereInput[] {
  return reviewedFirstCollectionBoards(policy).map(board => board.slug === '*' ? { platform: board.platform } : board);
}

/** Large catalogues stream through existing page/segment backpressure. Reserving
 * the whole catalogue against the 1,000-job publication window would deadlock. */
export function reviewedFirstCollectionReserveJobs(policy: AtsFirstCollectionPolicy): number {
  return Math.min(250, policy.maxCatalogueJobs);
}
