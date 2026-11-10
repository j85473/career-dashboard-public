import { load } from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';
import { additionalBoardSlug, additionalRequest, parseAdditionalDetail, parseAdditionalListing, parseFlatchrPublicPage, ADDITIONAL_ATS_LABELS, type AdditionalPublicAts } from './additionalPublicAts';
import { readBoundedAtsBody } from './tenantAtsBoards';
import type { AtsScrapeResult } from './atsApi';

export function additionalPostingPlatform(input: string): AdditionalPublicAts | null {
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (/^[a-z0-9-]+\.homerun\.co$/.test(u.hostname) && additionalBoardSlug('homerun', input) && /^\/[^/]+\/?$/.test(u.pathname)) return 'homerun';
    if (additionalBoardSlug('softgarden', input) && /^\/(?:job|jobs)\/[1-9]\d*(?:\/|$)/.test(u.pathname)) return 'softgarden';
    if (additionalBoardSlug('dvinci', input) && /\/jobs\/[1-9]\d*(?:\/|$)/.test(u.pathname)) return 'dvinci';
    if ((u.hostname === 'careers.flatchr.io' || additionalBoardSlug('flatchr', input)) && /^\/(?:[a-z]{2}\/)?vacancy\/[a-z0-9_-]+\/?$/i.test(u.pathname)) return 'flatchr';
  } catch { /* Unrelated or malformed URL. */ }
  return null;
}
export async function fetchAdditionalAtsPosting(url: string, read: typeof safeExternalFetch = safeExternalFetch): Promise<AtsScrapeResult | null> {
  const platform = additionalPostingPlatform(url);
  if (!platform) return null;
  try {
    const u = new URL(url); u.search = ''; u.hash = '';
    if (platform === 'flatchr' && !u.pathname.endsWith('/')) u.pathname += '/';
    const source = u.href;
    let slug = additionalBoardSlug(platform, source), job: Record<string, unknown> | undefined;
    const request = async (target: string) => {
      const r = await read(target, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json,text/html' } });
      if (!r.ok) throw Error('Exact public posting request failed');
      if (r.url && new URL(r.url).href !== target) {
        const landed = new URL(r.url), requested = new URL(target);
        const sameSoftgardenPosting = platform === 'softgarden' && additionalBoardSlug(platform, r.url) === slug
          && /\/job\/([1-9]\d*)(?:\/|$)/.exec(landed.pathname)?.[1] === /\/job\/([1-9]\d*)(?:\/|$)/.exec(requested.pathname)?.[1]
          && /\/job\/[1-9]\d*(?:\/|$)/.test(requested.pathname);
        if (!sameSoftgardenPosting) throw Error('Exact public posting request changed identity');
      }
      return readBoundedAtsBody(r);
    };
    if (platform === 'flatchr') {
      const body = await request(source), $ = load(body), data = JSON.parse($('#__NEXT_DATA__').text());
      const company = data?.props?.config?.company;
      slug = typeof company?.slug === 'string' ? company.slug : null;
      if (!slug || additionalBoardSlug(platform, `https://careers.flatchr.io/fr/company/${slug}/`) !== slug) return null;
      const vacancy = u.pathname.split('/').filter(Boolean).at(-1)!;
      const feed = parseFlatchrPublicPage(slug, body, vacancy);
      job = feed.jobs.find(j => new URL(String(j.url)).pathname.split('/').filter(Boolean).at(-1) === vacancy);
    } else if (!slug) return null;
    else if (platform === 'homerun' || platform === 'softgarden' && !slug.includes('.career.softgarden.')) {
      job = parseAdditionalDetail(platform, slug, await request(source), source);
    } else {
      const body = await request(additionalRequest(platform, slug).url);
      const feed = parseAdditionalListing(platform, slug, platform === 'dvinci' ? JSON.parse(body) : {}, body);
      const postingId = /\/(?:jobs|job)\/([1-9]\d*)(?:\/|$)/.exec(u.pathname)?.[1];
      job = feed.jobs.find(j => j.publicAtsPostingId === postingId);
    }
    if (!job || !slug) return null;
    const $ = load(String(job.description)); $('script,style,template,[hidden],[aria-hidden="true"]').remove();
    $('p,div,li,br,h1,h2,h3,h4').append('\n');
    const text = $.text().replace(/[^\S\n]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, title: String(job.title), company: String(job.company), location: typeof job.location === 'string' ? job.location : undefined,
      ats: ADDITIONAL_ATS_LABELS[platform], platform, atsSlug: slug };
  } catch { return null; }
}
