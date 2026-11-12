import type { JobListItem } from '@/types/job';

/** Re-read the loaded range so inserts and removals cannot leave page gaps. */
export async function fetchClientJobPages<P extends { page: number; total: number; hasMore: boolean }>(
  url: string, params: URLSearchParams, pages: number[], signal: AbortSignal,
): Promise<{ jobs: JobListItem[]; pagination: P; location?: { label?: string } }> {
  const results = await Promise.all(pages.map(async page => {
    const query = new URLSearchParams(params);
    query.set('page', String(page));
    const response = await fetch(`${url}?${query}`, { signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not refresh jobs.');
    return data as { jobs: JobListItem[]; pagination: P; location?: { label?: string } };
  }));
  return { ...results.at(-1)!, jobs: [...new Map(results.flatMap(result => result.jobs || []).map(job => [job.id, job])).values()] };
}
