import { canonicalEmployerPostingUrl } from './canonicalPosting';
import { savedPostingOwnerIds, sameEmployerPosting } from './savedPostingOwner';
import { boardIdentityFromUrl, isDirectPostingUrl, findStoredAtsPostings, resolveDirectAtsPostingFromCatalogue, selectDirectAtsMatch,
  type BoardIdentity, type BoardPosting, type DirectAtsMatch, type DirectMatchDeps, type DirectMatchJob } from './atsDirectMatch';

export type AggregatorIntakeDecision =
  | { kind: 'matched'; match: DirectAtsMatch }
  | { kind: 'unknown_board' }
  | { kind: 'expired'; reason: 'absent_from_complete_employer_catalogue'; boards: BoardIdentity[] }
  | { kind: 'pending'; reason: string };

/** Known employer boards are an admission check, not optional enrichment. */
export async function assessAggregatorIntake(job: DirectMatchJob, deps: DirectMatchDeps): Promise<AggregatorIntakeDecision> {
  try {
    // A publisher can supply an employer-branded application URL before we
    // know the publisher's employer name or which board serves that employer.
    const url = canonicalEmployerPostingUrl(job.canonicalUrl || job.url);
    const store = deps.store;
    if (url && store.$queryRaw) {
      const ids = await savedPostingOwnerIds({ job: store.job, $queryRaw: store.$queryRaw.bind(store) }, url);
      if (ids.length > 1) return { kind: 'pending', reason: 'multiple_saved_posting_owners' };
      if (ids.length === 1) {
        const owner = await store.job.findUnique({ where: { id: ids[0] }, select: { title: true, description: true,
          location: true, source: true, url: true, canonicalUrl: true, userCanonicalUrl: true,
          observations: { where: { source: { startsWith: 'ATS-' }, url }, select: { id: true }, take: 1 } } });
        if (owner && (isDirectPostingUrl(url) || /^ATS-/i.test(owner.source || '') || owner.userCanonicalUrl
          || owner.observations.length || owner.canonicalUrl && owner.canonicalUrl !== owner.url && sameEmployerPosting(owner.canonicalUrl, url))) {
          const board = boardIdentityFromUrl(url);
          return { kind: 'matched', match: { url: owner.userCanonicalUrl || url, description: owner.description,
            postingTitle: owner.title, postingLocation: /^ATS-/i.test(owner.source || '') ? owner.location : null,
            matchedVia: 'stored', matchedBy: 'source_url', platform: board?.platform || 'unknown', slug: board?.slug || '' } };
        }
      }
    }
    const catalogue = await findStoredAtsPostings(job.company, deps.store, [job], { includeRetiredBoards: true });
    let outcome: string = 'lookup_inconclusive';
    let completed: { boards: BoardIdentity[]; postings: BoardPosting[] } | undefined;
    const match = await resolveDirectAtsPostingFromCatalogue(job, catalogue, {
      ...deps, allowLivePing: true,
      onOutcome: value => { outcome = value; deps.onOutcome?.(value); },
      onLiveCatalogue: evidence => { completed = evidence; deps.onLiveCatalogue?.(evidence); },
    });
    if (match) return { kind: 'matched', match };
    if (outcome === 'cross_employer_unresolved') return { kind: 'pending', reason: outcome };
    if (outcome === 'no_verified_board') return catalogue.unavailableBoards?.length
      ? { kind: 'pending', reason: 'employer_board_excluded' } : { kind: 'unknown_board' };
    // One or several plausible live requisitions means ambiguity, not expiry.
    // A failed/unsupported/partial read never reaches onLiveCatalogue.
    if (completed && !catalogue.unavailableBoards?.length
      && !completed.postings.some(posting => selectDirectAtsMatch(job, [posting]))) {
      return { kind: 'expired', reason: 'absent_from_complete_employer_catalogue', boards: completed.boards };
    }
    return { kind: 'pending', reason: outcome };
  } catch {
    return { kind: 'pending', reason: 'employer_lookup_failed' };
  }
}
