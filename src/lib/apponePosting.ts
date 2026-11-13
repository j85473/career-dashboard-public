import * as cheerio from 'cheerio';
import type { AtsScrapeResult } from './atsApi';
import { appOnePostingIdentity } from './apponePostingIdentity';
import { cleanHtmlText } from './jobIngestion';
import { assessJobDescriptionQuality } from './jobDescriptionQuality';
import { US_STATE_LOCATION_PATTERN } from './postingLocation';
import { safeExternalFetch } from './safeExternalFetch';

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const unresolvedLocation = /^(?:field|all|unknown(?: location)?|n\/a|not specified)$/i;
const failure = 'AppOne did not return verified details for this opening. Use an individual job link or retry the posting.';

export class AppOnePostingUnavailableError extends Error {
  constructor() {
    super(failure);
    this.name = 'AppOnePostingUnavailableError';
  }
}

/** Read only the selected requisition's labeled table, never the surrounding page. */
export function parseAppOnePostingHtml(html: string, value: string): AtsScrapeResult | null {
  const identity = appOnePostingIdentity(value);
  if (!identity || !/^\/MainInfoReq\.asp$/i.test(new URL(value).pathname)) return null;
  const $ = cheerio.load(html);
  const table = $('table#JobDescription');
  if (table.length !== 1) return null;
  const ids = table.find('input[name]').toArray()
    .filter(node => /^r_id$/i.test($(node).attr('name') || ''))
    .map(node => $(node).attr('value'));
  if (ids.length !== 1 || ids[0] !== identity.id) return null;
  const formIds = $('form[action]').toArray().map(node => {
    try { return appOnePostingIdentity(new URL($(node).attr('action')!, value).href)?.id; }
    catch { return undefined; }
  }).filter(Boolean);
  if (formIds.some(id => id !== identity.id)) return null;
  if (/\b(?:not currently|no longer|not) accepting applications\b/i.test(table.text())) return null;

  const fields = new Map<string, { label: string; html: string; text: string }>();
  for (const row of table.find('tr').toArray()) {
    if ($(row).closest('table')[0] !== table[0]) continue;
    const cells = $(row).children('td');
    if (cells.length !== 2) continue;
    const label = clean(cells.eq(0).text());
    const key = label.toLowerCase().replace(/\s*:\s*$/, '');
    if (!key) continue;
    if (fields.has(key)) return null;
    const cell = cells.eq(1).clone();
    cell.find('script,style,template,input,button,form,nav,[hidden],[aria-hidden="true"],a.button').remove();
    const fieldHtml = cell.html() || '';
    fields.set(key, { label, html: fieldHtml, text: cleanHtmlText(fieldHtml) });
  }
  const titleField = fields.get('title');
  const title = titleField && clean(cheerio.load(titleField.html)('h1').text());
  const description = fields.get('description');
  if (!title || title.length > 200 || !description?.text) return null;
  // Some employers put most of the substantive JD in Position Requirements.
  // Legal boilerplate and company background must not satisfy this check.
  const roleText = [description.text, fields.get('position requirements')?.text].filter(Boolean).join('\n\n');
  if (!assessJobDescriptionQuality(roleText, { structuredSource: true }).scorable) return null;

  const published = (property: string) => [...new Set($(`meta[itemprop="${property}"]`).toArray()
    .map(node => clean($(node).attr('content') || '')).filter(Boolean))];
  const publishedTitles = published('title');
  if (publishedTitles.some(candidate => candidate.toLowerCase() !== title.toLowerCase())) return null;
  const employers = published('hiringOrganization');
  const company = employers.length === 1 ? employers[0] : fields.get('company')?.text || fields.get('employer')?.text;
  if (employers.length > 1 || !company || /^(?:unknown(?: company)?|appone|paychex|company)$/i.test(company)
    || company.length > 200 || /^https?:\/\//i.test(company)) return null;

  // AppOne can publish the employer's HQ in microdata and "Field" in the
  // generic Location row. Explicit job-region text and title are more specific.
  const regions = [...new Set([...description.text.matchAll(/^\s*Location(?:\s*\/\s*Region)?\s*:\s*([^\n]{1,160})$/gim)]
    .map(match => clean(match[1])).filter(region => !unresolvedLocation.test(region)))];
  const titleLocation = new RegExp(`\\s[-–|]\\s([^,;|]+,\\s*(?:${US_STATE_LOCATION_PATTERN}))$`, 'i').exec(title)?.[1];
  const rowLocation = clean(fields.get('location')?.text || '');
  const cities = published('addressLocality'), states = published('addressRegion');
  const location = regions.join('; ') || titleLocation
    || (rowLocation && !unresolvedLocation.test(rowLocation) ? rowLocation : undefined)
    || (cities.length === 1 && states.length <= 1 ? [cities[0], states[0]].filter(Boolean).join(', ') : undefined);

  const extraFields = new Set(['position requirements', 'full-time/part-time', 'travel requirements', 'exempt/non-exempt',
    'salary', 'salary range', 'compensation', 'pay range', 'eoe statement', 'about the organization']);
  const extras = [...fields].filter(([key, field]) => extraFields.has(key) && field.text)
    .map(([, field]) => `${field.label}\n${field.text}`);
  const text = [description.text, ...extras].join('\n\n');
  return { ats: 'AppOne', title, company, location, text, postingUrl: identity.descriptionUrl };
}

/** A failed AppOne read must not fall through to a whole-page reader. */
export async function fetchAppOnePosting(value: string, fetcher: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult> {
  const unavailable = (): AtsScrapeResult => ({ ats: 'AppOne', text: '', postingVerificationError: failure });
  const identity = appOnePostingIdentity(value);
  if (!identity) return unavailable();
  try {
    const response = await fetcher(identity.descriptionUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(15000),
    });
    const finalUrl = response.url || identity.descriptionUrl;
    if (!response.ok || appOnePostingIdentity(finalUrl)?.id !== identity.id) return unavailable();
    return parseAppOnePostingHtml(await response.text(), finalUrl) || unavailable();
  } catch { return unavailable(); }
}
