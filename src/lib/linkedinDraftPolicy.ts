export interface DraftRecord {
  id: string;
  title: string;
  postText: string;
  url: string;
  createdAt: Date | string;
  copiedAt?: Date | string | null;
  source?: unknown;
}

export interface ArticleUse {
  url: string;
  status: string;
  createdAt: Date | string;
  updatedAt?: Date | string;
}

/** Keep path/query case: publisher IDs and Google's encoded IDs are case-sensitive. */
export function articleKey(input: string): string {
  const url = new URL(input.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid article URL.');
  url.protocol = 'https:';
  url.hostname = url.hostname.replace(/^www\./, '');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

export function sameArticle(left: string, right: string, legacy = false): boolean {
  try {
    const a = articleKey(left), b = articleKey(right);
    return a === b || (legacy && a.toLowerCase() === b.toLowerCase());
  } catch { return left.trim() === right.trim(); }
}

export function normalizedPost(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function similarPosts(left: string, right: string): boolean {
  const a = normalizedPost(left), b = normalizedPost(right);
  if (a === b) return true;
  const shingles = (text: string) => {
    const words = text.split(' ');
    return new Set(words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(' ')));
  };
  const aa = shingles(a), bb = shingles(b);
  if (Math.min(aa.size, bb.size) < 12) return false;
  const overlap = [...aa].filter(word => bb.has(word)).length;
  return overlap / Math.min(aa.size, bb.size) >= 0.7;
}

export function isLegacyTemplate(text: string): boolean {
  return text.includes('adds a useful signal:') && [
    'Channel growth is operational before it is strategic.',
    'A go-to-market plan is only as strong as the route to revenue it can actually run.',
    'Partner performance problems usually surface in operations before they show up in revenue.',
    'Execution is where a market idea becomes a business result.',
  ].some(hook => text.startsWith(hook));
}

export type DraftStatus = 'draft' | 'posted' | 'passed' | 'legacy' | 'duplicate';

export function draftViews(drafts: DraftRecord[], used: ArticleUse[]) {
  const sorted = [...drafts].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt) || b.id.localeCompare(a.id));
  const completed = drafts.filter(d => used.some(u => ['posted', 'passed'].includes(u.status) && sameArticle(d.url, u.url, true)));
  const available: DraftRecord[] = [];
  return sorted.map(draft => {
    const decisions = used.filter(u => sameArticle(draft.url, u.url, true));
    const decision = decisions.find(u => u.status === 'posted') || decisions.find(u => u.status === 'passed');
    let status: DraftStatus = decision?.status === 'posted' ? 'posted' : decision ? 'passed' : 'draft';
    if (status === 'draft' && isLegacyTemplate(draft.postText)) status = 'legacy';
    if (status === 'draft' && [...completed, ...available].some(d => sameArticle(d.url, draft.url) || similarPosts(d.postText, draft.postText))) status = 'duplicate';
    if (status === 'draft') available.push(draft);
    return { ...draft, status, trackedAt: decision?.updatedAt || decision?.createdAt || null };
  });
}

export function articleAlreadySeen(url: string, drafts: DraftRecord[], used: ArticleUse[]): boolean {
  return drafts.some(d => sameArticle(d.url, url)) || used.some(u => sameArticle(u.url, url, true));
}
