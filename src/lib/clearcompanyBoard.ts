import { load } from 'cheerio';

export const isClearCompanySiteId = (value: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const tenant = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
const reserved = /^(?:www|api|app|apply|jobs|careers|careers-api|careers-content|help|support|docs)$/i;

/** These are discovery aliases only. Admission resolves them to the existing site UUID. */
export function clearCompanyPageSlug(value: string): string | null {
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    const hosted = u.hostname === 'apply.clearcompany.com' ? /^\/([\w-]+)\/?$/.exec(u.pathname)?.[1] : null;
    if (hosted && tenant.test(hosted) && !reserved.test(hosted)) return `hosted::${hosted.toLowerCase()}`;
    const legacy = /^([\w-]+)\.hrmdirect\.com$/.exec(u.hostname)?.[1];
    if (legacy && !reserved.test(legacy) && (u.pathname === '/' || /^\/employment(?:\/(?:(?:job-openings|job-opening|view|index)\.php)?)?$/i.test(u.pathname))) return `hrmdirect::${legacy.toLowerCase()}`;
    const employer = /^([\w-]+)\.clearcompany\.com$/.exec(u.hostname)?.[1];
    if (employer && !reserved.test(employer) && /^\/careers\/jobs\/[\w-]+(?:\/apply)?\/?$/.test(u.pathname)) return `hosted::${employer.toLowerCase()}`;
    return null;
  } catch { return null; }
}

export function clearCompanyPageUrl(slug: string): string | null {
  const match = /^(hosted|hrmdirect)::([a-z0-9][a-z0-9_-]{0,99})$/.exec(slug);
  if (!match || reserved.test(match[2])) return null;
  return match[1] === 'hosted' ? `https://apply.clearcompany.com/${match[2]}`
    : `https://${match[2]}.hrmdirect.com/employment/job-openings.php?search=true`;
}

/** Read the publisher's widget configuration, never an arbitrary UUID in page text. */
export function clearCompanyEmbeddedSiteIds(html: string, pageUrl: string): string[] {
  const $ = load(html), ids = new Set<string>();
  let conflicting = false;
  $('script[src]').each((_index, element) => {
    try {
      const script = $(element), url = new URL(script.attr('src') || '', pageUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'careers-content.clearcompany.com' || url.username || url.password || url.port
        || !/^\/js\/v1\/career-site(?:-no-polyfill)?\.js$/.test(url.pathname)) return;
      const values = [script.attr('data-site-id'), url.searchParams.get('siteId'), url.searchParams.get('siteid')].filter((v): v is string => !!v);
      if (!values.length || values.some(v => !isClearCompanySiteId(v)) || new Set(values.map(v => v.toLowerCase())).size !== 1) {
        conflicting = true;
        return;
      }
      ids.add(values[0].toLowerCase());
    } catch { /* Unrelated or malformed scripts are not board evidence. */ }
  });
  return conflicting ? [] : [...ids];
}

export function resolveClearCompanyPage(slug: string, html: string, landedUrl?: string): string {
  if (!clearCompanyPageUrl(slug)) throw new Error('Invalid ClearCompany discovery alias');
  const landed = landedUrl ? clearCompanyPageSlug(landedUrl) : slug;
  // HRMDirect now redirects to the same tenant on the hosted career site.
  if (!landed || landed.split('::')[1] !== slug.split('::')[1]) throw new Error('ClearCompany page redirected to a different employer');
  const ids = clearCompanyEmbeddedSiteIds(html, landedUrl || clearCompanyPageUrl(slug)!);
  if (ids.length !== 1) throw new Error('ClearCompany career page needs one verified site ID');
  return ids[0];
}

export function admittedClearCompanySlug(slug: string, canonicalSlug?: string): string {
  if (!canonicalSlug) return slug;
  if (!clearCompanyPageUrl(slug) || !isClearCompanySiteId(canonicalSlug)) throw new Error('Invalid resolved ClearCompany site identity');
  return canonicalSlug.toLowerCase();
}
