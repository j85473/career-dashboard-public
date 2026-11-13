import * as cheerio from 'cheerio';

export const SEQUOIA_DISCOVERY_BOOTSTRAP = 'https://jobs.sequoiacap.com/companies';
const ENDPOINT = 'https://jobs.sequoiacap.com/api-boards/search-companies';
const PAGE_SIZE = 21;
export type SequoiaDiscoverySession = { token: string; cookie: string };

export function sequoiaDiscoveryApiUrl(sequence?: string): string {
  const url = new URL(ENDPOINT);
  if (sequence !== undefined) {
    if (!sequence || sequence.length > 1024) throw new Error('Invalid Sequoia directory continuation');
    url.searchParams.set('sequence', sequence);
  }
  return url.href;
}

export function isSequoiaDiscoveryApiUrl(value: string): boolean {
  const url = new URL(value);
  return url.origin === new URL(ENDPOINT).origin && url.pathname === new URL(ENDPOINT).pathname
    && !url.username && !url.password && !url.hash
    && [...url.searchParams.keys()].every(key => key === 'sequence')
    && url.searchParams.size <= 1
    && (!url.searchParams.has('sequence') || !!url.searchParams.get('sequence') && url.searchParams.get('sequence')!.length <= 1024);
}

/** Anonymous public-page session. Kept in memory for one pass, never saved to crawl state. */
export function sequoiaDiscoverySession(html: string, cookies: readonly string[]): SequoiaDiscoverySession {
  const $ = cheerio.load(html);
  let token = '';
  $('script:not([src])').each((_index, node) => {
    const script = $(node).text();
    if (!/window\.serverInitialData\s*=\s*\{\s*"fixedBoard"\s*:\s*"sequoia-capital"/.test(script)) return;
    const match = /"csrfToken"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(script);
    if (match) token = JSON.parse(match[1]);
  });
  const cookie = cookies.map(value => value.split(';', 1)[0]).join('; ');
  if (!token || token.length > 2048 || !cookie || cookie.length > 8192) throw new Error('Sequoia public directory session unavailable');
  return { token, cookie };
}

export function sequoiaDiscoveryRequest(url: string, session: SequoiaDiscoverySession) {
  if (!isSequoiaDiscoveryApiUrl(url)) throw new Error('Not a supported Sequoia directory URL');
  const sequence = new URL(url).searchParams.get('sequence');
  return {
    method: 'POST' as const,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json',
      'X-CSRF-Token': session.token, Cookie: session.cookie },
    body: JSON.stringify({ query: {}, meta: { size: PAGE_SIZE, ...(sequence ? { sequence } : {}) },
      board: { id: 'sequoia-capital', isParent: true } }),
  };
}

/** Consume only published employer websites and the directory's opaque continuation. */
export function sequoiaDiscoveryDestinations(body: string, pageUrl: string): { websites: string[]; nextUrl: string | null } {
  if (!isSequoiaDiscoveryApiUrl(pageUrl)) throw new Error('Not a supported Sequoia directory URL');
  const data = JSON.parse(body);
  if (!data || !Array.isArray(data.companies) || data.companies.length > PAGE_SIZE
    || !Number.isSafeInteger(data.total) || data.total < 0 || data.total < data.companies.length
    || !data.meta || typeof data.meta !== 'object' || !Array.isArray(data.errors) || data.errors.length) {
    throw new Error('Unrecognized Sequoia public directory response');
  }
  const sequence: unknown = data.meta.sequence;
  if (sequence != null && typeof sequence !== 'string') throw new Error('Invalid Sequoia directory continuation');
  const nextUrl = sequence ? sequoiaDiscoveryApiUrl(sequence as string) : null;
  if ((sequence && sequence === new URL(pageUrl).searchParams.get('sequence')) || (nextUrl && !data.companies.length)
    || (!new URL(pageUrl).searchParams.has('sequence') && data.total > data.companies.length && !nextUrl)) {
    throw new Error('Incomplete Sequoia public directory response');
  }
  const websites: string[] = [];
  for (const company of data.companies) {
    if (!company || typeof company !== 'object' || typeof company.id !== 'string') throw new Error('Invalid Sequoia directory company');
    if (typeof company.website?.url === 'string') websites.push(company.website.url);
  }
  return { websites: [...new Set(websites)], nextUrl };
}
