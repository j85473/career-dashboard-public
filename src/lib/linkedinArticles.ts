import { load } from 'cheerio';
import Parser from 'rss-parser';
import { safeExternalFetch } from './safeExternalFetch';
import { articleKey } from './linkedinDraftPolicy';

export const LINKEDIN_FEEDS = [
  'https://www.channeldive.com/feeds/news/',
  'https://www.channelinsider.com/feed/',
];
export const ARTICLE_MAX_AGE_DAYS = 30;

export interface ArticleCandidate {
  title: string;
  url: string;
  publishedAt: string;
}

export interface LinkedInArticle extends ArticleCandidate {
  discoveredUrl: string;
  publisher: string;
  body: string;
  retrievedAt: string;
}

const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
const CHANNEL = /\b(channel partners?|channel sales|partner programs?|partner enablement|partner incentives?|resellers?|distributors?|distribution partners?|indirect sales|go.to.market|route.to.market|sales enablement|partner ecosystem|partner operations)\b/gi;

export function articleRelevance(text: string): number {
  return new Set((text.match(CHANNEL) || []).map(s => s.toLowerCase())).size;
}

export function isRecentArticle(value: string, now = new Date()): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= +now + 60 * 60_000
    && timestamp >= +now - ARTICLE_MAX_AGE_DAYS * 86_400_000;
}

export function extractLinkedInArticle(html: string, finalUrl: string, candidate: ArticleCandidate, now = new Date()): LinkedInArticle {
  const $ = load(html);
  const title = compact($('h1').first().text() || $('meta[property="og:title"]').attr('content') || '');
  const words = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const expected = words(candidate.title), actual = words(title);
  if (!title || [...expected].filter(w => actual.has(w)).length / Math.max(1, expected.size) < 0.6) {
    throw Error('The publisher returned a different page from the requested article.');
  }
  if (/"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(html)) throw Error('This article requires a subscription.');
  const publishedAt = $('meta[property="article:published_time"]').attr('content')
    || $('time[datetime]').first().attr('datetime') || candidate.publishedAt;
  if (!isRecentArticle(publishedAt, now)) throw Error('This article is outside the recent publication window.');

  const canonical = $('link[rel="canonical"]').attr('href');
  const canonicalUrl = canonical ? new URL(canonical, finalUrl) : new URL(finalUrl);
  if (canonicalUrl.hostname.replace(/^www\./, '') !== new URL(finalUrl).hostname.replace(/^www\./, '')) {
    throw Error('The article canonical URL points to a different publisher.');
  }
  $('script,style,nav,footer,header,aside,form,[role="navigation"],.related-posts,.related-articles,.newsletter,.advertisement').remove();
  // Never use the whole page or a feed summary as a substitute for an article body.
  const bodies = ['[itemprop="articleBody"]', '.article-body', '.entry-content', 'article'].flatMap(selector =>
    $(selector).toArray().map(node => {
      const paragraphs = $(node).find('p,li,h2,h3').toArray().map(p => compact($(p).text())).filter(p => p.length >= 40);
      return [...new Set(paragraphs)].join('\n\n');
    }));
  // Prefer a specific body container over the surrounding article layout.
  const body = bodies.find(text => text.split(/\s+/).length >= 150) || '';
  if (!body || body.split('\n\n').length < 3 || /enable javascript|verify you are human|subscribe to continue reading/i.test(body)) {
    throw Error('The full article could not be read.');
  }
  if (body.length > 40_000) throw Error('The article is too long for a complete grounded draft.');
  if (articleRelevance(body) < 1 || !/\b(sales|selling|sell|customers?|revenue|commissions?|enablement|onboarding|orders?)\b/i.test(body)) {
    throw Error('The article is not sufficiently focused on channel or partner work.');
  }
  return { title, url: canonicalUrl.toString(), discoveredUrl: candidate.url, publishedAt: new Date(publishedAt).toISOString(),
    publisher: canonicalUrl.hostname.replace(/^www\./, ''), body, retrievedAt: now.toISOString() };
}

export type ArticleFetch = (url: string, init: RequestInit) => Promise<Response>;
const readExternal: ArticleFetch = (url, init) => safeExternalFetch(url, init, 5, { maximumBytes: 3 * 1024 * 1024, maximumAddressAttempts: 2 });

export async function discoverLinkedInArticles(input: {
  alreadySeen: (url: string) => boolean;
  now?: Date;
  fetcher?: ArticleFetch;
  feeds?: string[];
}): Promise<LinkedInArticle[]> {
  const now = input.now || new Date(), fetcher = input.fetcher || readExternal;
  const deadline = AbortSignal.timeout(60_000);
  const read = (url: string) => fetcher(url, { signal: AbortSignal.any([deadline, AbortSignal.timeout(12_000)]),
    headers: { Accept: 'text/html,application/rss+xml,application/xml' } });
  const feeds = await Promise.allSettled((input.feeds || LINKEDIN_FEEDS).map(async url => {
    const response = await read(url);
    if (!response.ok) throw Error(`Publisher feed returned HTTP ${response.status}.`);
    const feed = await new Parser().parseString(await response.text());
    return feed.items.flatMap(item => {
      const title = item.title?.trim(), link = item.link?.trim(), publishedAt = item.isoDate || item.pubDate;
      if (!title || !link || !publishedAt || !isRecentArticle(publishedAt, now) || input.alreadySeen(link)) return [];
      try {
        const target = new URL(link);
        if (target.hostname.replace(/^www\./, '') !== new URL(url).hostname.replace(/^www\./, '')) return [];
        if (/\/(spons|sponsored|press-releases?)(\/|$)/i.test(target.pathname)) return [];
        return [{ title, url: target.toString(), publishedAt }];
      } catch { return []; }
    });
  }));
  const seen = new Set<string>();
  const candidates = feeds.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    .filter(candidate => { const key = articleKey(candidate.url); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => articleRelevance(b.title) - articleRelevance(a.title) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const articles: LinkedInArticle[] = [];
  // Bounded, independent reads; one blocked publisher does not discard readable sources.
  for (let offset = 0; offset < Math.min(candidates.length, 12) && articles.length < 3 && !deadline.aborted; offset += 3) {
    const results = await Promise.allSettled(candidates.slice(offset, offset + 3).map(async candidate => {
      const response = await read(candidate.url);
      if (!response.ok) throw Error(`Article returned HTTP ${response.status}.`);
      if (!response.headers.get('content-type')?.includes('text/html')) throw Error('Publisher did not return an HTML article.');
      return extractLinkedInArticle(await response.text(), response.url || candidate.url, candidate, now);
    }));
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const article = result.value;
      if (!input.alreadySeen(article.url) && !articles.some(a => articleKey(a.url) === articleKey(article.url))) articles.push(article);
      if (articles.length === 3) break;
    }
  }
  if (!articles.length) throw Error('No fresh, relevant articles could be read from the publishers. Your saved drafts are unchanged. Try again later.');
  return articles;
}
