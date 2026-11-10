/** Harvest these sources before their collectors exist. These entries must
 * never become schedulable boards or first-collection reservations. */
export const FUTURE_ATS_DISCOVERY_PATTERNS = {
  cornerstone: ['*.csod.com/*'],
  hireology: ['careers.hireology.com/*', '*.hireology.careers/*'],
  polymer: ['jobs.polymer.co/*', 'api.polymer.co/v1/hire/organizations/*'],
  homerun: ['*.homerun.co/*'],
  softgarden: ['*.softgarden.io/*', '*.softgarden.de/*', '*.softgarden.com/*'],
  dvinci: ['*.dvinci-hr.com/*', '*.dvinci.de/*', '*.dvinci-easy.com/*'],
  flatchr: ['*.flatchr.io/*'],
} as const;

export type FutureAtsPlatform = keyof typeof FUTURE_ATS_DISCOVERY_PATTERNS;
const atom = /^[a-z0-9][a-z0-9_-]*$/i;
const infrastructure = /^(?:www\d*|api|app|admin|help|support|docs|developers?|blog|static|assets|cdn|status|login|demo|test|training)$/i;

/** A discovery candidate is a public source address, not a verified employer.
 * Preserve aliases for later validation; do not invent vendor tenant IDs. */
export function futureAtsCandidateUrl(platform: FutureAtsPlatform, value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const origin = `https://${host}`;
    if (platform === 'cornerstone' && /^[a-z0-9-]+\.csod\.com$/.test(host) && !infrastructure.test(host.split('.')[0])) {
      const modern = /^\/ux\/ats\/careersite\/(\d+)(?:\/|$)/i.exec(url.pathname);
      if (modern) return `${origin}/ux/ats/careersite/${Number(modern[1])}/home`;
      if (/^\/ats\/careersite\//i.test(url.pathname)) {
        const query = new Map([...url.searchParams].map(([key, val]) => [key.toLowerCase(), val]));
        const site = query.get('site');
        if (site && /^\d+$/.test(site)) return `${origin}/ux/ats/careersite/${Number(site)}/home`;
        // Legacy sites without a published site number need later resolution.
        return `${origin}${url.pathname}`;
      }
    }
    if (platform === 'hireology') {
      if (host === 'careers.hireology.com' && atom.test(parts[0] || '') && !infrastructure.test(parts[0])) return `${origin}/${parts[0]}`;
      if (/^[a-z0-9-]+\.hireology\.careers$/.test(host) && !infrastructure.test(host.split('.')[0])) return `${origin}/`;
    }
    if (platform === 'polymer') {
      const slug = host === 'jobs.polymer.co' ? parts[0]
        : host === 'api.polymer.co' && parts.slice(0, 3).join('/') === 'v1/hire/organizations' ? parts[3] : '';
      if (atom.test(slug || '') && !infrastructure.test(slug)) return `https://jobs.polymer.co/${slug}`;
    }
    if (platform === 'homerun' && /^[a-z0-9-]+\.homerun\.co$/.test(host) && !infrastructure.test(host.split('.')[0])) {
      return host === 'feed.homerun.co' ? (parts.length ? `${origin}${url.pathname}` : null) : `${origin}/`;
    }
    if (platform === 'softgarden' && /\.(?:softgarden\.io|softgarden\.de|softgarden\.com)$/.test(host)
      && !infrastructure.test(host.split('.')[0])) return `${origin}/`;
    if (platform === 'dvinci' && /\.(?:dvinci-hr\.com|dvinci\.de|dvinci-easy\.com)$/.test(host)
      && !infrastructure.test(host.split('.')[0])) {
      return parts[0] === 'portal' && atom.test(parts[1] || '') ? `${origin}/portal/${parts[1]}/` : `${origin}/`;
    }
    if (platform === 'flatchr' && host.endsWith('.flatchr.io')) {
      if (host === 'careers.flatchr.io') {
        const companyIndex = parts.indexOf('company');
        const slug = companyIndex >= 0 ? (parts[companyIndex + 1] || '').replace(/\.json$/i, '') : '';
        if (atom.test(slug)) return `${origin}/company/${slug}`;
        // Vacancy links can precede discovery of their owning company.
        if (parts.some(part => /^(?:vacanc(?:y|ies)|offres?)$/i.test(part))) return `${origin}${url.pathname}`;
      } else if (!infrastructure.test(host.split('.')[0])) return `${origin}/`;
    }
  } catch { /* Malformed and unrelated addresses are not candidates. */ }
  return null;
}

