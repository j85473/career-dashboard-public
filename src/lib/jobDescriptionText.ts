import { cleanJobDescriptionPage } from './jobDescriptionCleanup';

/** Strip reader transport and decorative markup only from a verified reader envelope. */
export function cleanJobDescriptionText(value: string): string {
  const cleaned = cleanJobDescriptionPage(value);
  if (cleaned !== value) return cleaned;
  const header = /^Markdown Content:[ \t]*\r?$/m.exec(value);
  if (!header) return value;
  const preamble = value.slice(0, header.index);
  const source = /^URL Source:[ \t]*(https?:\/\/\S+)[ \t]*\r?$/m.exec(preamble)?.[1];
  if (!source) return value;
  let sourceUrl: URL;
  try { sourceUrl = new URL(source); } catch { return value; }
  let body = value.slice(header.index + header[0].length).trim();

  // SAP's branded pages surround one posting with repeated menus, apply buttons
  // and related-job links. Require the vendor asset, matching title and matching
  // same-host apply target before using those boundaries; never guess from headings.
  const id = /^\/job\/[^/]+\/(\d+)\/?$/.exec(sourceUrl.pathname)?.[1];
  const title = /^Title:[ \t]*(.+?)\r?$/m.exec(preamble)?.[1]?.trim();
  const heading = [...body.matchAll(/^# ([^\n]+)\r?$/gm)].filter(match => match[1].trim() === title);
  const apply = [...body.matchAll(/^\[Apply now[^\]]*\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)[ \t]*\r?$/gm)]
    .filter(match => {
      try {
        const target = new URL(match[1]);
        return target.origin === sourceUrl.origin && target.pathname === `/talentcommunity/apply/${id}/`;
      } catch { return false; }
    });
  const sapAsset = /https?:\/\/rmkcdn\.successfactors\.com\//i.test(body);
  if (id && sapAsset && heading.length === 1) {
    const start = heading[0].index! + heading[0][0].length;
    const before = apply.some(match => match.index! < heading[0].index!);
    const end = apply.find(match => match.index! > start)?.index;
    if (before && end !== undefined) {
      body = body.slice(start, end).trim()
        .replace(/\n+\*\*Nearest Major Market:\*\*[^\n]*\n[ \t]*\*\*Job Segment:\*\*[^\n]*\s*$/i, '').trim();
    }
  }
  body = removeReaderImages(body).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim();
  // Keep transport failures available to the closure/quality checks. Removing
  // reader furniture must never make a missing posting appear to be live.
  const warnings = preamble.split(/\r?\n/).filter(line => /^Warning:/i.test(line));
  return warnings.length ? `${warnings.join('\n')}\n\nMarkdown Content:\n${body}` : body;
}

/** Handle linked images and parentheses in destinations without leaving URL fragments. */
function removeReaderImages(value: string): string {
  let result = '';
  for (let i = 0; i < value.length;) {
    const image = value.startsWith('![', i);
    if (!image && value[i] !== '[') { result += value[i++]; continue; }
    const open = i + (image ? 1 : 0);
    let end = open + 1;
    let depth = 1;
    for (; end < value.length && depth; end++) {
      if (value[end] === '\\') { end++; continue; }
      if (value[end] === '[') depth++;
      if (value[end] === ']') depth--;
    }
    if (depth || value[end] !== '(') { result += value[i++]; continue; }
    let close = end + 1;
    depth = 1;
    for (; close < value.length && depth; close++) {
      if (value[close] === '\\') { close++; continue; }
      if (value[close] === '(') depth++;
      if (value[close] === ')') depth--;
    }
    if (depth) { result += value[i++]; continue; }
    const label = value.slice(open + 1, end - 1);
    if (image) {
      // Descriptive alt text may contain actual requirements. Keep it while
      // discarding reader numbering, empty placeholders and decorative labels.
      const alt = label.replace(/^Image\s+\d+(?::\s*|$)/i, '').trim();
      if (alt && !/^(?:(?:company|employer|corporate|brand|header|footer)\s+)?(?:logo|icon|banner)(?:\s+image)?$/i.test(alt)) result += alt;
    } else if (label.includes('![')) {
      const alt = removeReaderImages(label).trim();
      if (alt) result += alt;
    } else {
      // Keep authored links, including accommodation contacts and documents.
      result += value.slice(i, close);
    }
    i = close;
  }
  return result;
}
