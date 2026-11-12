const JOB_KEY = /^[a-f0-9]{16}$/i;

export function isIndeedHost(host: string): boolean {
  return /^(?:(?:www|m|[a-z]{2})\.)?indeed\.(?:com|ca|co\.uk|com\.au|co\.in|de|fr|ie|nl|es|it|ch|at|be|co\.za|co\.nz|com\.mx|com\.br|jp|sg)$/i.test(host);
}

/** The selected opening, not advertising IDs or the other jobs on a search page. */
export function indeedPostingKey(value: string | null | undefined): string | null {
  try {
    const url = new URL(value || '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !isIndeedHost(url.hostname)) return null;
    // vjk is the selected job in Indeed's search-results split pane.
    const selected = url.searchParams.getAll('vjk');
    const explicit = selected.length ? selected : url.searchParams.getAll('jk');
    if (explicit.length) return explicit.every(key => JOB_KEY.test(key) && key.toLowerCase() === explicit[0].toLowerCase())
      ? explicit[0].toLowerCase() : null;
    return /^\/job\/[^/]+-([a-f0-9]{16})\/?$/i.exec(url.pathname)?.[1].toLowerCase() || null;
  } catch { return null; }
}

/** Retrieval/deduplication only; the user's exact link remains on the card. */
export function indeedPostingUrl(value: string): string | null {
  const key = indeedPostingKey(value);
  if (!key) return null;
  return `https://${new URL(value).hostname}/viewjob?jk=${key}`;
}
