import * as cheerio from 'cheerio';
import type { BrowserDocument } from './browserAtsPosting';

export class PublicBoardUnavailableError extends Error {}

/** Paylocity uses the same branded unavailable page for a missing board and
 * a closed individual posting. The caller's requested resource owns the scope. */
export function isPaylocityUnavailablePage(doc: BrowserDocument): boolean {
    const url = new URL(doc.url), $ = cheerio.load(doc.html);
    return url.protocol === 'https:' && url.hostname === 'recruiting.paylocity.com'
        && /^\/recruiting\/jobs\/JobNotFound\/?$/i.test(url.pathname)
        && $('title').text().trim() === 'Job Not Found'
        && /We're sorry, that job does not exist or is not currently active\./.test(doc.text)
        && (/Powered by Paylocity/.test(doc.text)
            || $('aside[aria-label="Powered by Paylocity Logo and Link"] img').attr('src') === 'https://cdn.paylocity.com/cdn/branding/paylocity-logo-left.svg');
}

/** A vendor's explicit unavailable page is a retry, never an empty catalogue. */
export function assertPublicBoardAvailable(platform: string, doc: BrowserDocument): void {
    const url = new URL(doc.url);
    if (/Performing security verification|Verify you are human|Just a moment/i.test(doc.text)
        && /challenge-platform|cf-chl-|_cf_chl_opt|Performance and Security by Cloudflare/i.test(doc.html))
        throw new PublicBoardUnavailableError('Public career site requires security verification; retaining progress for retry');
    if (platform === 'jobvite' && url.protocol === 'https:' && ['www.jobvite.com', 'jobvite.com'].includes(url.hostname)
        && /^\/support\/job-seeker-support\/?$/.test(url.pathname) && url.searchParams.get('invalid') === '1'
        && /Job Seeker Support/.test(doc.text))
        throw new PublicBoardUnavailableError('Jobvite reports this employer career site is unavailable; retain for weekly retry');
    if (platform !== 'paylocity') return;
    if (isPaylocityUnavailablePage(doc))
        throw Error('Paylocity reports this public board is unavailable; retain for weekly retry');
}
