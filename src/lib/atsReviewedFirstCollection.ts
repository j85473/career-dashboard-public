import type { AtsFirstCollectionPolicy } from './prismaClient';

/** A separate, explicit allowlist; the ordinary 250-job policy stays unchanged. */
export const REVIEWED_FIRST_COLLECTION_POLICY_ID = 'reviewed-oversized';
export const REVIEWED_FIRST_COLLECTION_MAXIMUM_JOBS = 5000;

export function reviewedFirstCollectionBoards(policy: AtsFirstCollectionPolicy | null): Array<{ platform: string; slug: string }> {
  if (!policy || policy.id !== REVIEWED_FIRST_COLLECTION_POLICY_ID || policy.maxUnfinished !== 1
    || !['capacity', 'held'].includes(policy.mode)
    || policy.maxCatalogueJobs < 251 || policy.maxCatalogueJobs > 10000
    || !Array.isArray(policy.pilotBoards) || !policy.pilotBoards.length || policy.pilotBoards.length > 100) return [];
  const boards: Array<{ platform: string; slug: string }> = [];
  for (const key of policy.pilotBoards) {
    if (typeof key !== 'string') return [];
    const split = key.indexOf('::');
    const platform = key.slice(0, split), slug = key.slice(split + 2);
    if (split < 1 || !(platform === 'clearcompany' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(slug)
      || platform === 'symphony' && ['hgv', 'victoriassecret'].includes(slug))) return [];
    if (!boards.some(board => board.platform === platform && board.slug === slug)) boards.push({ platform, slug });
  }
  return boards;
}

export function isReviewedFirstCollection(policy: AtsFirstCollectionPolicy | null, board: { platform: string; slug: string }): boolean {
  return reviewedFirstCollectionBoards(policy).some(value => value.platform === board.platform && value.slug === board.slug);
}

/** Large catalogues stream through existing page/segment backpressure. Reserving
 * the whole catalogue against the 1,000-job publication window would deadlock. */
export function reviewedFirstCollectionReserveJobs(policy: AtsFirstCollectionPolicy): number {
  return Math.min(250, policy.maxCatalogueJobs);
}
