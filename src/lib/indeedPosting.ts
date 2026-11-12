import { load } from 'cheerio';
import type { AtsScrapeResult } from './atsApi';
import { fetchWithKeyRotation, getRapidApiKeys } from './apiFallback';
import { prismaKeyCooldownStore } from './apiKeyCooldownStore';
import { reserveProviderBudgetForSource } from './ingestionControl';
import { assessJobDescriptionQuality } from './jobDescriptionQuality';
import { isGenericManualImportTitle, manualImportCompanyValue } from './manualImportPolicy';
import { parseJsonLdWithRecovery } from './lenientJson';
import { safeExternalFetch } from './safeExternalFetch';
import { indeedPostingKey, indeedPostingUrl } from './indeedPostingUrl';

export const INDEED_IMPORT_HELP = 'Indeed did not provide complete details for this opening. It may require sign-in or be blocking automated access. Paste the job title, employer, and full description below to import it. No job was imported.';

const value = (input: unknown): string => typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
const record = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
function description(input: unknown): string {
  if (typeof input !== 'string') return '';
  const $ = load(input);
  $('script,style,nav,footer,form').remove();
  $('br,p,div,li,h1,h2,h3,h4').append('\n');
  return $.root().text().replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

export function suppliedIndeedPosting(input: { title?: unknown; company?: unknown; location?: unknown; description?: unknown }, url: string): AtsScrapeResult | null {
  const title = value(input.title);
  const company = manualImportCompanyValue(value(input.company), url);
  const text = description(input.description);
  if (!indeedPostingKey(url) || !title || isGenericManualImportTitle(title) || /^(?:viewjob|indeed|authenticating|sign in)(?:\b|$)/i.test(title)
    || !company || /^indeed$/i.test(company) || !assessJobDescriptionQuality(text, { structuredSource: true }).scorable) return null;
  return { title, company, location: value(input.location) || undefined, text, ats: 'Unknown', postingUrl: indeedPostingUrl(url)! };
}

/** Only the requested posting's own description field can become a JD. */
export function parseIndeedDetail(payload: unknown, url: string): AtsScrapeResult | null {
  const row = record(payload);
  const expected = indeedPostingKey(url);
  if (!expected) return null;
  for (const field of ['id', 'job_id', 'jobkey', 'jobKey']) {
    if (row[field] != null && value(row[field]).toLowerCase() !== expected) return null;
  }
  for (const field of ['url', 'job_url']) {
    if (row[field] != null && indeedPostingKey(value(row[field])) !== expected) return null;
  }
  return suppliedIndeedPosting({ title: row.title || row.job_title, company: row.company_name || row.company,
    location: row.location, description: row.description }, url);
}

/** Ignore recommendations, login forms, and page chrome even when they are long. */
export function parseIndeedPostingHtml(html: string, url: string): AtsScrapeResult | null {
  const $ = load(html);
  const expected = indeedPostingKey(url);
  if (!expected) return null;
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical && indeedPostingKey(canonical) !== expected) return null;
  const postings: Record<string, unknown>[] = [];
  function visit(input: unknown) {
    if (Array.isArray(input)) { input.forEach(visit); return; }
    const row = record(input);
    if ([row['@type']].flat().includes('JobPosting')) postings.push(row);
    if (row['@graph']) visit(row['@graph']);
  }
  $('script[type="application/ld+json"]').each((_, node) => visit(parseJsonLdWithRecovery($(node).text())));
  const matching = postings.filter(row => row.url ? indeedPostingKey(value(row.url)) === expected : postings.length === 1);
  for (const row of matching) {
    const locations = (Array.isArray(row.jobLocation) ? row.jobLocation : [row.jobLocation]).map(place => {
      const address = record(record(place).address);
      return [address.addressLocality, address.addressRegion, address.addressCountry].map(value).filter(Boolean).join(', ');
    }).filter(Boolean);
    const result = suppliedIndeedPosting({ title: row.title, company: record(row.hiringOrganization).name,
      location: locations.join('; ') || (row.jobLocationType === 'TELECOMMUTE' ? 'Remote' : undefined), description: row.description }, url);
    if (result) return result;
  }
  // The classic job view can omit JSON-LD but retains these posting-scoped fields.
  if (postings.length || !$('#jobDescriptionText').length) return null;
  return suppliedIndeedPosting({ title: $('[data-testid="jobsearch-JobInfoHeader-title"], .jobsearch-JobInfoHeader-title').first().text(),
    company: $('[data-testid="inlineHeader-companyName"], [data-company-name="true"]').first().text(),
    location: $('[data-testid="job-location"]').first().text(), description: $('#jobDescriptionText').html() }, url);
}

export type IndeedPostingDependencies = {
  readPage: (url: string) => Promise<{ url: string; html: string } | null>;
  readDetail: (key: string) => Promise<unknown>;
};

/** Shared by manual imports and description recovery; does not depend on job.source. */
export async function fetchIndeedPosting(url: string, dependencies?: IndeedPostingDependencies): Promise<AtsScrapeResult> {
  const key = indeedPostingKey(url);
  const postingUrl = indeedPostingUrl(url);
  if (!key || !postingUrl) return { ats: 'Unknown', text: '', postingVerificationError: 'Use an individual Indeed job link containing jk or vjk. No job was imported.' };
  const readPage = dependencies?.readPage || (async (target: string) => {
    const response = await safeExternalFetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) });
    return response.ok ? { url: response.url, html: await response.text() } : null;
  });
  try {
    const page = await readPage(postingUrl);
    const result = page && indeedPostingKey(page.url) === key ? parseIndeedPostingHtml(page.html, postingUrl) : null;
    if (result) return result;
  } catch { /* Access failure is not evidence that the opening closed. */ }

  try {
    const readDetail = dependencies?.readDetail || (async (jobKey: string) => {
      const response = await fetchWithKeyRotation(getRapidApiKeys(), async apiKey => {
        const reservation = await reserveProviderBudgetForSource('Indeed Details');
        if (!reservation.allowed) throw new Error(`Indeed Details request blocked by ${reservation.reason}`);
        return fetch(`https://indeed12.p.rapidapi.com/job/${jobKey}`, { cache: 'no-store',
          headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': 'indeed12.p.rapidapi.com' }, signal: AbortSignal.timeout(30_000) });
      }, 'Indeed12_Details', { store: prismaKeyCooldownStore });
      if (!response?.ok) throw new Error(`Indeed Details HTTP ${response?.status || 'unavailable'}`);
      return response.json();
    });
    const result = parseIndeedDetail(await readDetail(key), postingUrl);
    if (result) return result;
  } catch { /* Retain shared budgets/cooldowns; offer the manual fallback. */ }
  return { ats: 'Unknown', text: '', postingUrl, postingVerificationError: INDEED_IMPORT_HELP };
}
