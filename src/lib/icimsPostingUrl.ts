const ICIMS_JOB_PATH_PATTERN = /^\/jobs\/(\d+)((?:\/[^/?#]+)*)\/(?:job|login)\/?$/i;

// The public iframe can return 405 to the generic Chrome-style user agent.
export const ICIMS_FETCH_USER_AGENT = 'Mozilla/5.0';

/** The public description lives in a same-origin iframe, including for /login aliases. */
export function buildIcimsIframeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (url.hostname !== 'icims.com' && !url.hostname.endsWith('.icims.com')) return null;
    const pathMatch = url.pathname.match(ICIMS_JOB_PATH_PATTERN);
    if (!pathMatch) return null;
    url.pathname = `/jobs/${pathMatch[1]}${pathMatch[2]}/job`;
    url.searchParams.set('in_iframe', '1');
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

export function icimsPostingId(url: URL): string | undefined {
  return url.pathname.match(ICIMS_JOB_PATH_PATTERN)?.[1];
}

export function icimsPostingUrlsMatch(left: string, right: string): boolean {
  const a = buildIcimsIframeUrl(left);
  const b = buildIcimsIframeUrl(right);
  return Boolean(a && b && a.hostname === b.hostname && icimsPostingId(a) === icimsPostingId(b));
}
