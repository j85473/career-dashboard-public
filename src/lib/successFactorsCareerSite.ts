import * as cheerio from 'cheerio';
import { cleanHtmlText } from './jobIngestion';
import { assessJobDescriptionQuality } from './jobDescriptionQuality';
import { postingUrlsMatch } from './postingMetadata';
import type { AtsScrapeResult } from './atsApi';

/** Employer-branded SAP Career Site Builder pages publish their provider configuration. */
export function isSuccessFactorsCareerSite(html: string): boolean {
  const $ = cheerio.load(html);
  const scripts = $('script:not([src])').map((_, node) => $(node).text()).get().join('\n');
  const sso = /["']?ssoUrl["']?\s*:\s*["'](https?:\/\/[^"']+)["']/i.exec(scripts)?.[1];
  if (!sso || !/\bj2w\.init\s*\(/.test(scripts)) return false;
  try {
    const url = new URL(sso);
    return /^career\d*\.(?:successfactors|sapsf)\.(?:com|eu)$/i.test(url.hostname)
      && !url.username && !url.password;
  } catch { return false; }
}

/** Read SAP's published microdata only after the exact posting identity agrees. */
export function parseSuccessFactorsCareerSitePosting(html: string, url: string): AtsScrapeResult | null {
  if (!isSuccessFactorsCareerSite(html)) return null;
  const $ = cheerio.load(html);
  const canonical = $('link[rel="canonical"]').attr('href');
  if (!canonical || !postingUrlsMatch(canonical, url)) return null;
  const parsed = new URL(url);
  const id = /^\/job\/[^/]+\/(\d+)\/?$/.exec(parsed.pathname)?.[1];
  if (!id) return null;
  const shells = $('.jobDisplayShell[itemscope][itemtype$="/JobPosting"]');
  if (shells.length !== 1) return null;
  const shell = shells.first();
  const applies = shell.find('a[href]').toArray().some(node => {
    try {
      const apply = new URL($(node).attr('href')!, url);
      return apply.origin === parsed.origin && apply.pathname === `/talentcommunity/apply/${id}/`;
    } catch { return false; }
  });
  if (!applies) return null;
  const title = shell.find('[itemprop="title"]').first().text().replace(/\s+/g, ' ').trim();
  const companyNode = shell.find('[itemprop="hiringOrganization"]').first();
  const company = (companyNode.attr('content') || companyNode.text()).replace(/\s+/g, ' ').trim();
  const text = cleanHtmlText(shell.find('[itemprop="description"]').first().html() || '');
  if (!title || !company || !assessJobDescriptionQuality(text, { structuredSource: true }).scorable) return null;
  const locations = shell.find('[itemprop="address"]').toArray().map(node => {
    const address = $(node);
    const value = (key: string) => address.find(`[itemprop="${key}"]`).attr('content')?.trim();
    return [value('addressLocality'), value('addressRegion'), value('addressCountry')].filter(Boolean).join(', ');
  }).filter(Boolean);
  return { ats: 'SuccessFactors', text, title, company,
    ...(locations.length ? { location: [...new Set(locations)].join('; ') } : {}) };
}
