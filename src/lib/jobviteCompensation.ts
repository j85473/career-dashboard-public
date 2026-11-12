import * as cheerio from 'cheerio';
import { jobvitePostingIdentity } from './jobviteLocation';
import { extractPostedCompensation } from './postedCompensation';
import type { AtsScrapeResult } from './atsApi';

/** Only the exact opening's metadata header can supply an omitted salary line. */
export function withJobviteSalaryHeader(html: string, url: string, description: string): string {
  const identity = jobvitePostingIdentity(url);
  if (!identity) return description;
  const $ = cheerio.load(html);
  const matchingApply = $('a[href]').toArray().some(node => {
    try {
      const apply = new URL($(node).attr('href')!, url);
      if (!/\/apply\/?$/.test(apply.pathname)) return false;
      apply.pathname = apply.pathname.replace(/\/apply\/?$/, '');
      return jobvitePostingIdentity(apply.href) === identity;
    } catch { return false; }
  });
  if (!matchingApply) return description;
  const headers = new Set<string>();
  $('.jv-job-detail-meta').each((_, node) => {
    const header = $(node).clone();
    header.find('script,style').remove();
    header.find('br').replaceWith('\n');
    const salary = /\bSalary\s*:[^\n]+/i.exec(header.text())?.[0]
      .split(/\bPosting Closes\s*:/i)[0].replace(/\s+/g, ' ').trim();
    if (salary) headers.add(salary);
  });
  const missing = [...headers].filter(header => !description.includes(header));
  return [...missing, description].join('\n\n');
}

/** Complete aggregator descriptions can still omit the employer's pay header.
 * This is called only for unseen arrivals; it never refreshes an existing card.
 */
export async function recoverJobviteCompensation(input: {
  url: string | null | undefined;
  description: string;
}, readPosting?: (url: string) => Promise<AtsScrapeResult | null>): Promise<string | null> {
  if (!input.url || !jobvitePostingIdentity(input.url) || extractPostedCompensation(input.description)) return null;
  const read = readPosting || (await import('./atsApi')).scrapeAtsApi;
  const posting = await read(input.url).catch(() => null);
  return posting?.ats === 'Jobvite' && !posting.postingVerificationError && extractPostedCompensation(posting.text)
    ? posting.text : null;
}
