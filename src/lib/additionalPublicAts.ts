import { load } from 'cheerio';
import { SaxesParser } from 'saxes';
import { publishedEmployerName } from './publicAtsEmployer';

export const ADDITIONAL_PUBLIC_ATS = ['homerun', 'softgarden', 'dvinci', 'flatchr'] as const;
export type AdditionalPublicAts = typeof ADDITIONAL_PUBLIC_ATS[number];
export const isAdditionalPublicAts = (platform: string): platform is AdditionalPublicAts => (ADDITIONAL_PUBLIC_ATS as readonly string[]).includes(platform);
export const ADDITIONAL_ATS_LABELS = { homerun: 'Homerun', softgarden: 'Softgarden', dvinci: 'd.vinci', flatchr: 'Flatchr' } as const;
type Row = Record<string, unknown>;
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const row = (v: unknown): Row => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Public career feed expected an object'); return v as Row; };
const list = (v: unknown): Row[] => { if (!Array.isArray(v)) throw Error('Public career feed expected a job array'); return v.map(row); };
const atom = /^[a-z0-9][a-z0-9_-]*$/i;
const reserved = /^(?:www\d*|api|app|admin|help|support|docs|developers?|blog|static|assets|cdn|status|login|demo|test|training|404)$/i;
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const country = (v: unknown): string => { const s = typeof v === 'object' && v ? text((v as Row).isoA2) || text((v as Row).name) : text(v); return /^[a-z]{2}$/i.test(s) ? countryNames.of(s.toUpperCase()) || s : s; };
const id = (v: unknown): string => { const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : text(v); if (!/^[a-z0-9][a-z0-9_-]*$/i.test(s)) throw Error('Public career posting ID is missing'); return s; };

/** Only public vendor namespaces identify boards; posting-only aliases stay unresolved. */
export function additionalBoardSlug(platform: AdditionalPublicAts, input: string): string | null {
  try {
    const u = new URL(input), host = u.hostname.toLowerCase(), parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port || reserved.test(host.split('.')[0])) return null;
    if (platform === 'homerun') {
      if (host === 'feed.homerun.co') return atom.test(parts[0] || '') && parts.length === 1 ? parts[0] : null;
      return /^[a-z0-9-]+\.homerun\.co$/.test(host) ? host.split('.')[0] : null;
    }
    if (platform === 'softgarden') return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.softgarden\.(?:io|de|com)$/.test(host) ? host : null;
    if (platform === 'dvinci' && /^[a-z0-9-]+\.(?:dvinci-hr\.com|dvinci\.de|dvinci-easy\.com)$/.test(host)) {
      if (parts[0] === 'portal') return atom.test(parts[1] || '') ? `${host}::${parts[1]}` : null;
      const portalIndex = parts.indexOf('p');
      if (portalIndex >= 0) return atom.test(parts[portalIndex + 1] || '') ? `${host}::${parts[portalIndex + 1]}` : null;
      return host;
    }
    if (platform === 'flatchr') {
      if (host === 'careers.flatchr.io') {
        const pos = parts.indexOf('company'), slug = pos >= 0 ? (parts[pos + 1] || '').replace(/\.json$/i, '') : '';
        return atom.test(slug) && !reserved.test(slug) ? slug : null;
      }
      return /^[a-z0-9-]+\.flatchr\.io$/.test(host) ? host.split('.')[0] : null;
    }
  } catch { /* Invalid addresses never supply identity. */ }
  return null;
}
export function additionalBoardUrl(platform: AdditionalPublicAts, slug: string): string {
  let url: string;
  if (platform === 'homerun') url = `https://${slug}.homerun.co/`;
  else if (platform === 'flatchr') url = `https://careers.flatchr.io/fr/company/${slug}/`;
  else if (platform === 'dvinci') { const [host, portal, extra] = slug.split('::'); if (extra || portal && !atom.test(portal)) throw Error('Invalid d.vinci portal'); url = `https://${host}/${portal ? `portal/${portal}/` : ''}`; }
  else url = `https://${slug}/`;
  if (additionalBoardSlug(platform, url) !== slug) throw Error('Invalid public career board identity');
  return url;
}
export function additionalRequest(platform: AdditionalPublicAts, slug: string, offset = 0): { url: string; init: RequestInit } {
  const board = additionalBoardUrl(platform, slug);
  if (offset !== 0) throw Error('Public career feed does not accept offsets');
  const url = platform === 'homerun' ? `https://feed.homerun.co/${slug}` : platform === 'dvinci' ? `${board}jobPublication/list.json`
    : platform === 'softgarden' ? `${board}${slug.includes('.career.softgarden.') ? 'jobs.feed.json' : 'en/vacancies'}` : board;
  return { url, init: { headers: { Accept: 'application/json,application/atom+xml,text/html' } } };
}
function sameBoard(platform: AdditionalPublicAts, slug: string, url: string): URL {
  const u = new URL(url);
  const identity = additionalBoardSlug(platform, url);
  const scopedDvinci = identity !== null && platform === 'dvinci' && u.hostname === slug.split('::')[0]
    && (!slug.includes('::') || identity === slug.split('::')[0]);
  if (u.protocol !== 'https:' || identity !== slug && !scopedDvinci) throw Error('Public career posting changed board identity');
  return u;
}
function finish(slug: string, jobs: Row[]) {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!text(job.title) || !text(job.publicAtsPostingId) || seen.has(String(job.id))) throw Error('Public career feed has missing or repeated postings');
    seen.add(String(job.id));
  }
  return { jobs, total: jobs.length, metadata: { name: [...new Set(jobs.map(j => text(j.company)).filter(Boolean))].length === 1 ? jobs[0]?.company || '' : '', boardSlug: slug } };
}
function posting(slug: string, postingId: string, values: Row): Row { return { id: `${slug}::${postingId}`, publicAtsPostingId: postingId, ...values }; }
function structuredSalary(data: Row): string | undefined {
  if (!data.baseSalary || Array.isArray(data.baseSalary)) return undefined;
  const salary = row(data.baseSalary), amount = row(salary.value), currency = text(salary.currency), period = text(amount.unitText);
  const low = amount.minValue ?? amount.value, high = amount.maxValue ?? amount.value;
  return /^[A-Z]{3}$/.test(currency) && period && typeof low === 'number' && typeof high === 'number' && low > 0 && high >= low
    ? `${currency} ${low}${high !== low ? `–${high}` : ''} / ${period}` : undefined;
}
export function structuredLocation(data: Row): string {
  const places = Array.isArray(data.jobLocation) ? data.jobLocation : data.jobLocation ? [data.jobLocation] : [];
  const locations = places.map(p => { const place = row(p), a = place.address ? row(place.address) : {}; return [text(a.addressLocality), text(a.addressRegion), country(a.addressCountry)].filter(Boolean).join(', '); }).filter(Boolean);
  if (data.jobLocationType === 'TELECOMMUTE') {
    const requirements = Array.isArray(data.applicantLocationRequirements) ? data.applicantLocationRequirements : data.applicantLocationRequirements ? [data.applicantLocationRequirements] : [];
    const restrictions = requirements.map(v => country(row(v).name)).filter(Boolean);
    locations.unshift(restrictions.length ? `Remote (${restrictions.join('; ')})` : 'Remote');
  }
  return [...new Set(locations)].join('; ');
}
function structuredJob(platform: AdditionalPublicAts, slug: string, data: Row): Row {
  if (data['@type'] !== 'JobPosting') throw Error('Career feed item is not a job posting');
  const url = text(data.url), u = sameBoard(platform, slug, url);
  const urlId = /\/(?:job|jobs)\/([1-9]\d*)(?:\/|$)/.exec(u.pathname)?.[1];
  const postingId = id(row(data.identifier).value);
  if (urlId !== postingId) throw Error('Career posting ID does not match its URL');
  const company = publishedEmployerName(row(data.hiringOrganization).name);
  if (!company || !text(data.description)) throw Error('Career posting is missing employer or full description');
  if (text(data.validThrough) && new Date(text(data.validThrough)).valueOf() < Date.now()) throw Error('Career feed contains an expired posting');
  return posting(slug, postingId, { title: text(data.title), company, description: text(data.description), url, location: structuredLocation(data),
    createdAt: text(data.datePosted), postedCompensation: structuredSalary(data) });
}
export function parseAdditionalListing(platform: AdditionalPublicAts, slug: string, parsed: unknown, body: string | null) {
  additionalBoardUrl(platform, slug);
  if (platform === 'homerun') {
    const xml = body?.trim() || '';
    if (!xml.endsWith('</feed>') || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('Homerun requires a complete Atom feed');
    new SaxesParser({ xmlns: true }).write(xml).close();
    const $ = load(xml, { xmlMode: true }), root = $.root().children();
    if (root.length !== 1 || !root.is('feed') || root.attr('xmlns') !== 'http://www.w3.org/2005/Atom' || root.children('link[rel="next"]').length) throw Error('Unsupported Homerun feed envelope or continuation');
    sameBoard(platform, slug, root.children('id').text().trim());
    return finish(slug, root.children('entry').toArray().map(e => {
      const n = $(e), url = n.children('link[rel="alternate"][type="text/html"]').attr('href') || '';
      sameBoard(platform, slug, url);
      const postingId = id(n.children('id').text().trim()), company = publishedEmployerName(n.children('author').children('name').text());
      const description = n.children('description').text().trim();
      if (!company || !description) throw Error('Homerun feed is missing the employer or full description');
      const location = n.children('location').children('name').text().trim();
      return posting(slug, postingId, { title: n.children('title').text().trim(), company, description, url,
        location: location === company ? '' : location, createdAt: n.children('updated').text().trim() });
    }));
  }
  if (platform === 'dvinci') {
    return finish(slug, list(parsed).map(j => {
      const postingId = id(j.id), opening = row(j.jobOpening), company = publishedEmployerName(row(opening.company).name);
      const url = text(j.jobPublicationURL) || text(j.applicationFormURL), u = sameBoard(platform, slug, url);
      if (!new RegExp(`/jobs/${postingId}(?:/|$)`).test(u.pathname)) throw Error('d.vinci posting URL changed identity');
      const content = j.renderedContent ? row(j.renderedContent) : {};
      const preferred = ['introduction','position','tasks','profile','weOffer','additionalInformation','closingText','contact'];
      const sections = [...preferred, ...Object.keys(content).filter(key => !preferred.includes(key))]
        .map(key => content[key]).filter(Boolean).map(v => { const s = row(v); return [text(s.headline) ? `<h2>${text(s.headline)}</h2>` : '', text(s.body)].join(''); }).filter(Boolean);
      const description = sections.length ? sections.join('\n') : ['introduction','tasks','profile','weOffer','closingText'].map(k => text(j[k])).filter(Boolean).join('\n');
      if (!company || !description) throw Error('d.vinci feed is missing employer or full description');
      const locations = Array.isArray(opening.locations) ? opening.locations.map(v => { const a = row(v); return [text(a.name), country(a.country)].filter(Boolean).join(', '); }) : [];
      return posting(slug, postingId, { title: text(j.position), company, description, url, location: locations.join('; ') || text(opening.location),
        createdAt: text(j.startDate), postedCompensation: text(opening.salaryRange) || undefined });
    }));
  }
  if (platform === 'flatchr') return parseFlatchrPublicPage(slug, body);
  const raw = body || '';
  if (slug.includes('.career.softgarden.')) {
    const data = row(JSON.parse(raw)), entries = list(data.dataFeedElement);
    if (data['@type'] !== 'DataFeed' || data.numberOfItems !== entries.length || text(row(data.meta).source) !== additionalBoardUrl(platform, slug)) throw Error('Softgarden feed is incomplete or changed source');
    return finish(slug, entries.map(e => structuredJob(platform, slug, row(e.item))));
  }
  if (!raw.trim().endsWith('</html>')) throw Error('Incomplete Softgarden career page');
  const match = /\bcomplete_job_id_list\s*=\s*jobs_selected\s*=\s*(\[[\d\s,]*\])/.exec(raw);
  if (!match) throw Error('Softgarden complete job catalogue is missing');
  const ids = JSON.parse(match[1]) as number[];
  if (new Set(ids).size !== ids.length || ids.some(i => !Number.isSafeInteger(i) || i <= 0)) throw Error('Softgarden complete job list has invalid IDs');
  const $ = load(raw), jobs = ids.map(postingId => {
    const entry = $(`#job_id_${postingId}`), link = entry.find('a[href]').first();
    if (entry.length !== 1 || !link.length) throw Error('Softgarden HTML does not contain the complete catalogue');
    const url = new URL(link.attr('href') || '', `${additionalBoardUrl(platform, slug)}en/vacancies`).href, u = sameBoard(platform, slug, url);
    if (!u.pathname.startsWith(`/job/${postingId}/`)) throw Error('Softgarden posting URL ID mismatch');
    return posting(slug, String(postingId), { title: link.text().trim(), company: '', description: '', url,
      location: entry.find('.location-view-item').toArray().map(n => $(n).text().trim()).join('; ') });
  });
  return finish(slug, jobs);
}

/** Exact public detail is bound to both its publisher identity and immutable listing title. */
export function parseAdditionalDetail(platform: AdditionalPublicAts, slug: string, html: string, url: string, expectedTitle?: string, expectedId?: string): Row {
  if (platform !== 'softgarden' && platform !== 'homerun') throw Error('Unsupported exact career detail');
  const u = sameBoard(platform, slug, url), $ = load(html), records: Row[] = [];
  $('script[type="application/ld+json"]').each((_i, n) => {
    try { const data = JSON.parse($(n).text()); for (const item of Array.isArray(data) ? data : Array.isArray(data['@graph']) ? data['@graph'] : [data]) if (item['@type'] === 'JobPosting') records.push(row(item)); } catch { /* No authority from malformed structured data. */ }
  });
  if (platform === 'homerun') {
    const found = records.filter(j => text(j['@id']) === u.href && (!expectedId || text(row(j.identifier).value) === expectedId));
    if (found.length !== 1 || expectedTitle && text(found[0].title) !== expectedTitle) throw Error('Homerun detail changed posting identity or title');
    const data = found[0], company = publishedEmployerName(row(data.hiringOrganization).name);
    if (!company || !text(data.description)) throw Error('Homerun detail is incomplete');
    return posting(slug, id(row(data.identifier).value), { title: text(data.title), company, url, description: text(data.description), location: structuredLocation(data), postedCompensation: structuredSalary(data) });
  }
  const postingId = /\/job\/([1-9]\d*)(?:\/|$)/.exec(u.pathname)?.[1];
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const published = sameBoard(platform, slug, canonical);
  if (!postingId || /\/job\/([1-9]\d*)(?:\/|$)/.exec(published.pathname)?.[1] !== postingId || expectedId && expectedId !== postingId
    || records.length !== 1 || expectedTitle && text(records[0].title) !== expectedTitle) throw Error('Softgarden exact detail changed posting identity or title');
  const data = { ...records[0], url, identifier: { value: postingId } };
  return structuredJob(platform, slug, data);
}

export function parseFlatchrPublicPage(slug: string, body: string | null, vacancySlug?: string) {
  if (!body?.trim().endsWith('</html>')) throw Error('Incomplete Flatchr career page');
  const $ = load(body || ''), node = $('#__NEXT_DATA__');
  if (node.length !== 1) throw Error('Flatchr public career configuration is missing');
  const data = row(JSON.parse(node.text())), props = row(data.props), config = row(props.config), company = row(config.company);
  if ((vacancySlug ? data.page !== '/vacancy/[vacancySlug]' || text(row(data.query).vacancySlug) !== vacancySlug : data.page !== '/company/[companySlug]' || text(row(data.query).companySlug) !== slug) || text(company.slug) !== slug
    || company.IS_INTRANET_WEBSITE === true || config.published !== true) throw Error('Flatchr board is not the published public company site');
  const items = row(props.data);
  if (props.hasNoActiveDiffusion === true && list(items.items).length) throw Error('Flatchr inactive site returned postings');
  if (Object.keys(items).some(k => !['items', 'spontaneousV'].includes(k))) throw Error('Flatchr feed has an unsupported continuation');
  const publishedItems = list(items.items).filter(j => j.published === true && j.status === 'published' && row(j.vacancy).status === 1);
  if (items.spontaneousV && row(items.spontaneousV).published === true && row(items.spontaneousV).status === 1
    && !publishedItems.some(j => row(j.vacancy).id === row(items.spontaneousV).id)) publishedItems.push({ published: true, status: 'published', vacancy: items.spontaneousV });
  return finish(slug, publishedItems.map(j => {
    const v = row(j.vacancy), employer = row(v.company), postingId = id(v.id), vacancySlug = text(v.slug);
    if (text(employer.id) !== text(company.id) || text(employer.slug) !== slug || !vacancySlug.toLowerCase().startsWith(`${postingId.toLowerCase()}-`)) throw Error('Flatchr vacancy does not belong to this employer');
    const description = ['description','mission','profile'].map(k => text(v[k])).filter(Boolean).join('\n'), name = publishedEmployerName(employer.name);
    if (!name || !description) throw Error('Flatchr feed is missing employer or description');
    const address = row(v.address), location = [text(address.locality), text(address.administrative_area_level_1), country(address.country)].filter(Boolean).join(', ');
    return posting(slug, postingId, { title: text(v.title), company: name, description,
      url: `https://careers.flatchr.io/fr/vacancy/${encodeURIComponent(vacancySlug)}/`, location: `${v.remote === 'fulltime' ? 'Remote; ' : v.remote === 'parttime' ? 'Hybrid; ' : ''}${location}`, createdAt: text(j.publish_date) || text(j.created_at) });
  }));
}
