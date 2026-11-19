import * as cheerio from 'cheerio';
import { adpPostingIdentity } from './adpPostingIdentity';
import { manualImportCompanyValue } from './manualImportPolicy';
import { employerWebsiteName, publishedEmployerName } from './publicAtsEmployer';
import { readBoundedAtsBody } from './tenantAtsBoards';

const GENERIC_ADP_EMPLOYER_NAME = /^(?:ADP|Workforce Now|ADP Workforce Now|Default(?: Brand(?:ing)?)?|Recruitment|Careers?)$/i;

/** The public page uses ClientName, not ClientID, as the employer's name. */
export function adpClientFeaturesUrl(value: string): string | null {
  const identity = adpPostingIdentity(value);
  if (!identity) return null;
  const url = new URL('/mascsr/default/careercenter/public/events/staffing/client-features', identity.origin);
  for (const [key, value] of Object.entries({ cid: identity.cid, ccId: identity.ccId, lang: 'en_US', jobId: identity.jobId })) url.searchParams.set(key, value);
  return url.toString();
}

export function parseAdpClientCompany(body: unknown): string | undefined {
  const fields = (body as { meta?: { customFieldGroup?: { stringFields?: unknown } } } | null)?.meta?.customFieldGroup?.stringFields;
  if (!Array.isArray(fields)) return undefined;
  const names = new Set<string>();
  for (const field of fields) {
    if (!['ClientName', 'CLIENT_NAME'].includes(field?.nameCode?.codeValue)) continue;
    if (typeof field.stringValue === 'string' && !field.stringValue.trim()) continue;
    const name = typeof field.stringValue === 'string' ? manualImportCompanyValue(field.stringValue) : undefined;
    if (!name || name.length > 200 || GENERIC_ADP_EMPLOYER_NAME.test(name)) return undefined;
    names.add(name);
  }
  return names.size === 1 ? [...names][0] : undefined;
}

export type AdpPublicFetcher = (url: string, init: RequestInit) => Promise<Response>;
export type AdpCareerCenter = { contentLinks?: Array<{
    linkTypeCode?: { codeValue?: string; longName?: string };
    contentBody?: { links?: Array<{ href?: string; title?: string }> };
}>;
    meta?: { customFieldGroup?: { indicatorFields?: Array<{ nameCode?: { codeValue?: string }; indicatorValue?: boolean }> } } };
export class AdpPublicResponseError extends Error {}

function adpCorporateUrl(href: string | undefined): URL | null {
    try {
        const published = decodeURIComponent(href || '').trim();
        // A published bare hostname and a legacy HTTP link can both be read over HTTPS.
        const hostOnly = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:[/?#]|$)/i.test(published);
        const url = new URL(hostOnly ? 'https://' + published : published);
        if (url.protocol === 'http:') url.protocol = 'https:';
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || /(?:^|\.)(?:adp\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|twitter\.com|x\.com)$/.test(url.hostname)) return null;
        return url;
    } catch { return null; }
}

/** Only the career center's explicit corporate link supplies a website lookup.
 * Social links, opaque tenant IDs and logo filenames never supply a name. */
export function adpEmployerWebsite(body: AdpCareerCenter): string | null {
    const links = (body.contentLinks || []).filter(link => ['LINKS-BRND', 'IMG_LOGO'].includes(link.linkTypeCode?.codeValue || ''))
        .flatMap(link => link.contentBody?.links || [])
        .map(link => adpCorporateUrl(link.href)?.href).filter((href): href is string => Boolean(href));
    const unique = [...new Set(links)];
    if (unique.length === 1) return unique[0];
    // Career centers can list Website, Culture and Careers for one employer.
    // Prefer its explicitly published home URL, never guess one from a path.
    const hosts = new Set(unique.map(link => new URL(link).hostname.replace(/^www\./, '')));
    return hosts.size === 1 ? unique.find(link => {
        const url = new URL(link);
        return url.pathname === '/' && !url.search && !url.hash;
    }) || null : null;
}

/** The welcome heading and the named corporate home link must agree. */
function adpCareerCenterCompany(body: AdpCareerCenter): string | undefined {
    const headings = new Set<string>();
    const brands = new Map<string, string>();
    for (const entry of body.contentLinks || []) {
        if (entry.linkTypeCode?.codeValue === 'WELCOME-TXT' && typeof entry.linkTypeCode.longName === 'string') {
            const $ = cheerio.load(entry.linkTypeCode.longName);
            $('script,style').remove();
            for (const heading of $('h1,h2,h3,h4,h5,h6,b,strong').toArray()) {
                const text = $(heading).text().trim();
                const name = /^careers at\s+/i.test(text) ? publishedEmployerName(text) : '';
                if (name) headings.add(name.toLowerCase());
            }
        }
        if (entry.linkTypeCode?.codeValue !== 'LINKS-BRND') continue;
        for (const link of entry.contentBody?.links || []) {
            const url = adpCorporateUrl(link.href);
            if (url?.pathname !== '/' || url.search || url.hash) continue;
            const name = publishedEmployerName(link.title);
            if (name && name.length <= 200 && !GENERIC_ADP_EMPLOYER_NAME.test(name)) brands.set(name.toLowerCase(), name);
        }
    }
    if (headings.size !== 1 || brands.size !== 1) return undefined;
    return brands.get([...headings][0]);
}

export async function readAdpPublicJson(url: string, fetcher: AdpPublicFetcher,
    check: () => Promise<void> = async () => {}): Promise<unknown> {
        await check();
        try {
            const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
            if (!response.ok) {
                await response.body?.cancel();
                throw Error('Public JSON HTTP ' + response.status);
            }
            if (response.url && response.url !== url) {
                await response.body?.cancel();
                throw Error('ADP public JSON redirected away from its requested identity');
            }
            return JSON.parse(await readBoundedAtsBody(response, 5 * 1024 * 1024));
        } catch (error) {
            // Operator/admission checks above must propagate unchanged. Only
            // optional HTTP/response failures can fall through to other proof.
            throw new AdpPublicResponseError(error instanceof Error ? error.message : String(error), { cause: error });
        }
    }


export function adpCareerCenterUrl(postingUrl: string): string | null {
    const identity = adpPostingIdentity(postingUrl);
    if (!identity) return null;
    const url = new URL('/mascsr/default/careercenter/public/events/staffing/v1/content-links/career-center', identity.origin);
    for (const [key, value] of Object.entries({ cid: identity.cid, ccId: identity.ccId, lang: 'en_US', locale: 'en_US' })) url.searchParams.set(key, value);
    return url.href;
}

/** One reader per board turn or import; only published same-board evidence is
 * cached. An unavailable optional source never discards the verified posting. */
export class AdpEmployerEvidence {
    private employer?: Promise<{ name?: string; title?: string }>;
    constructor(private dependencies: {
        json: (url: string) => Promise<unknown>;
        careerCenter: () => Promise<AdpCareerCenter>;
        check: () => Promise<void>;
        fetcher: AdpPublicFetcher;
    }) {}
    async company(postingUrl: string, postingText: string): Promise<string | undefined> {
        const identity: { name?: string; title?: string } = await (this.employer ||= (async () => {
            let configured: string | undefined;
            try { configured = parseAdpClientCompany(await this.dependencies.json(adpClientFeaturesUrl(postingUrl)!)); }
            catch (error) { if (!(error instanceof AdpPublicResponseError)) throw error; }
            if (configured) return { name: configured };
            const careerCenter = await this.dependencies.careerCenter();
            const brand = adpCareerCenterCompany(careerCenter);
            if (brand) return { name: brand };
            const site = adpEmployerWebsite(careerCenter);
            if (!site) return {};
            await this.dependencies.check();
            let response: Response;
            try { response = await this.dependencies.fetcher(site, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }); }
            catch (error) { throw new AdpPublicResponseError('ADP employer website is unavailable', { cause: error }); }
            if (!response.ok) { await response.body?.cancel(); return {}; }
            const landed = new URL(response.url || site), requested = new URL(site);
            if (landed.protocol !== 'https:' || landed.hostname.replace(/^www\./, '') !== requested.hostname.replace(/^www\./, '')) {
                await response.body?.cancel(); return {};
            }
            let html: string;
            try { html = await readBoundedAtsBody(response, 5 * 1024 * 1024); }
            catch (error) { throw new AdpPublicResponseError('ADP employer website could not be read', { cause: error }); }
            const name = employerWebsiteName(html, site, landed.href);
            if (name && name.length <= 200) return { name };
            // Some corporate homepages publish only a plain company title.
            // It is a candidate until the exact posting independently names it.
            const title = publishedEmployerName(cheerio.load(html)('title').text());
            return title.length >= 5 && title.length <= 120 && !/[|<>:]/.test(title) ? { title } : {};
        })().catch(error => {
            if (error instanceof AdpPublicResponseError) return {};
            throw error;
        }));
        if (identity.name) return identity.name;
        if (identity.title) {
            const escaped = identity.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}\\s+(?:is|are)\\s+(?:seeking|hiring|recruiting|looking\\s+for)\\b`, 'iu').test(postingText)) return identity.title;
        }
        return undefined;
    }

}
