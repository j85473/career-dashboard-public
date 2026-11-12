import { load } from 'cheerio';

export type AshbyEmbed = {
  board?: string;
  postingUrl?: string;
  verificationError?: string;
};

const jobIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Read embed elements, never ordinary links, vendor mentions or guessed tenants. */
export function ashbyEmbed(html: string, pageUrl: string): AshbyEmbed | null {
  const $ = load(html);
  const boards = new Set<string>();
  const ids = new Set<string>();
  let invalidId = false;
  const addId = (value: string) => {
    if (!jobIdPattern.test(value)) invalidId = true;
    else ids.add(value);
  };
  for (const element of $('#ashby_embed[data-ashby-board], script[src], iframe[src]').toArray()) {
    const node = $(element);
    const value = node.attr('data-ashby-board') || node.attr('src');
    if (!value) continue;
    try {
      const url = new URL(value, pageUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'jobs.ashbyhq.com'
        || url.username || url.password || url.port) continue;
      const path = /^\/([a-z0-9_.-]+)(?:\/([^/]+))?(?:\/(?:application|apply))?\/?$/i.exec(url.pathname);
      if (!path || ['.', '..'].includes(path[1])) continue;
      const isScript = element.tagName === 'script';
      if (isScript && path[2] !== 'embed') continue;
      if (node.attr('data-ashby-board') && path[2]) continue;
      if (path[2] && path[2] !== 'embed' && !jobIdPattern.test(path[2])) continue;
      boards.add(path[1]);
      if (path[2] && path[2] !== 'embed') addId(path[2]);
    } catch { /* An unrelated or malformed source is not provider evidence. */ }
  }
  if (!boards.size) return null;
  const queryIds = new URL(pageUrl).searchParams.getAll('ashby_jid');
  if (queryIds.length > 1) invalidId = true;
  queryIds.forEach(addId);
  for (const element of $('#ashby_embed[data-jid]').toArray()) addId($(element).attr('data-jid')!);
  if (boards.size !== 1 || invalidId || ids.size > 1) {
    return { verificationError: 'This Ashby embed does not identify one unambiguous opening. Use the individual job link.' };
  }
  const board = [...boards][0];
  if (!ids.size) return { board, verificationError: 'This page embeds an Ashby job board but does not select an opening. Use the individual job link to refresh its details.' };
  return { board, postingUrl: `https://jobs.ashbyhq.com/${board}/${[...ids][0]}` };
}
