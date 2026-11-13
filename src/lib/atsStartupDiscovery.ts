import * as cheerio from 'cheerio';
import { isSequoiaDiscoveryApiUrl, sequoiaDiscoveryApiUrl } from './sequoiaDiscovery';

/** Public navigation only; these are discovery directories, never job collectors. */
export const STARTUP_VC_DISCOVERY_SEEDS = [
  'https://jobs.a16z.com/jobs',
  'https://jobs.a16z.com/companies',
  'https://jobs.sequoiacap.com/companies',
  'https://www.indexventures.com/companies/',
  'https://www.ycombinator.com/jobs',
  'https://www.ycombinator.com/jobs/role/sales-manager',
  'https://wellfound.com/jobs',
] as const;

const SOURCE_HOSTS = new Set([
  'jobs.a16z.com', 'jobs.sequoiacap.com', 'www.indexventures.com',
  'www.ycombinator.com', 'wellfound.com',
]);

function companyProfile(url: URL): string | null {
  const pattern = url.hostname === 'wellfound.com' ? /^\/company\/([^/]+)/
    : url.hostname === 'www.ycombinator.com' || url.hostname === 'www.indexventures.com' ? /^\/companies\/([^/]+)/
      : url.hostname === 'jobs.a16z.com' ? /^\/company\/([^/]+)/ : null;
  const match = pattern?.exec(url.pathname);
  if (!match || ['industry', 'location', 'backed'].includes(match[1])) return null;
  return `${url.origin}/${url.hostname === 'wellfound.com' || url.hostname === 'jobs.a16z.com' ? 'company' : 'companies'}/${match[1]}${url.hostname === 'www.indexventures.com' ? '/' : ''}`;
}

/** Keep source navigation focused on employers instead of account flows and editorial pages. */
export function startupDiscoveryPriority(value: string, pageUrl: string, label = ''): number | null {
  const page = new URL(pageUrl);
  if (!SOURCE_HOSTS.has(page.hostname)) return null;
  const url = new URL(value);
  if (isSequoiaDiscoveryApiUrl(value)) return 130;
  if (url.origin === page.origin) {
    const profile = companyProfile(url);
    if (profile) return url.pathname.replace(/\/$/, '') === new URL(profile).pathname.replace(/\/$/, '') ? 120 : 90;
    if (/^\/(?:companies|jobs)(?:\/|$)/.test(url.pathname) || /^\/startup-jobs\/?$/.test(url.pathname)) return 100;
    return -1;
  }
  // Public employer homepages and careers destinations can lead to a real ATS.
  // Never enter another YC account/product surface or a board vendor's own site.
  if (/(?:^|\.)(?:ycombinator\.com|workatastartup\.com|a16z\.com|sequoiacap\.com|consider\.com|indexventures\.com|wellfound\.com|wellfound\.ai|substack\.com)$/.test(url.hostname)) return -1;
  if (/(?:career|jobs|join-us)/i.test(url.pathname)) return 125;
  const profile = companyProfile(page);
  const onProfile = profile && page.pathname.replace(/\/$/, '') === new URL(profile).pathname.replace(/\/$/, '');
  const websiteLabel = label.toLowerCase().includes(url.hostname.replace(/^www\./, '').toLowerCase()) || label === 'Employer website';
  if (onProfile && url.pathname === '/' && !url.search && websiteLabel) return 125;
  return -1;
}

/** Recover employer routes published in public HTML; never execute page scripts. */
export function startupDiscoveryDestinations(html: string, pageUrl: string): string[] {
  const page = new URL(pageUrl);
  if (!SOURCE_HOSTS.has(page.hostname)) return [];
  const $ = cheerio.load(html);
  const destinations = new Set<string>();
  if (page.href === 'https://jobs.sequoiacap.com/companies' || page.href === 'https://jobs.sequoiacap.com/companies/') {
    destinations.add(sequoiaDiscoveryApiUrl());
  }
  $('a[href]').each((_index, node) => {
    if (/(?:^|\s)nofollow(?:$|\s)/i.test($(node).attr('rel') || '')) return;
    try {
      const url = new URL($(node).attr('href')!, pageUrl);
      if (url.origin !== page.origin) return;
      const profile = companyProfile(url);
      if (profile) destinations.add(profile);
    } catch { /* Invalid navigation is ignored. */ }
  });
  if (page.hostname === 'wellfound.com' && /^\/company\/[^/]+\/?$/.test(page.pathname)) {
    try {
      const data = JSON.parse($('#__NEXT_DATA__[type="application/json"]').text());
      const records = data?.props?.pageProps?.apolloState?.data;
      if (records && typeof records === 'object') for (const [key, value] of Object.entries(records)) {
        if (!key.startsWith('Startup:') || !value || typeof value !== 'object') continue;
        const company = value as { companyUrl?: unknown };
        if (typeof company.companyUrl === 'string') destinations.add(company.companyUrl);
      }
    } catch { /* A missing or changed payload leaves ordinary HTML links available. */ }
  }
  return [...destinations];
}
