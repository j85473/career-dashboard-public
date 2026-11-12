import assert from 'node:assert/strict';
import test from 'node:test';
import { ashbyEmbed } from '../../src/lib/ashbyEmbed';

const url = 'https://www.zafran.io/careers';
const id = '2aff777b-b582-4f46-ab33-28f4b8311928';
const board = 'https://jobs.ashbyhq.com/zafran-security';
// The employer's lazy-loaded embed publishes its board before loading the script.
export const zafranEmbed = `<div id="ashby_embed" data-ashby-board="${board}"></div>
  <p data-ashby-fallback><a href="${board}">View Open Positions</a></p>`;

test('recognizes both lazy-loaded employer embeds and the documented Ashby script', () => {
  for (const html of [zafranEmbed, `<div id="ashby_embed"></div><script src="${board}/embed?version=2"></script>`,
    `<iframe id="ashby_embed_iframe" src="${board}?embed=true"></iframe>`]) {
    const result = ashbyEmbed(html, url);
    assert.equal(result?.board, 'zafran-security');
    assert.equal(result?.postingUrl, undefined);
    assert.match(result!.verificationError!, /does not select an opening/);
  }
});

test('resolves one selected opening from the query, application embed or iframe', () => {
  for (const [html, page] of [
    [zafranEmbed, `${url}?ashby_jid=${id}&ref=joe#positions`],
    [zafranEmbed.replace('id="ashby_embed"', `id="ashby_embed" data-jid="${id}" data-tab="application"`), url],
    [`<iframe src="${board}/${id}/application?embed=true"></iframe>`, url],
  ]) {
    assert.deepEqual(ashbyEmbed(html, page), { board: 'zafran-security', postingUrl: `${board}/${id}` });
  }
});

test('rejects conflicting boards and conflicting, repeated or malformed job IDs', () => {
  for (const [html, page] of [
    [zafranEmbed + '<script src="https://jobs.ashbyhq.com/other/embed"></script>', url],
    [zafranEmbed, `${url}?ashby_jid=${id}&ashby_jid=${id}`],
    [zafranEmbed, `${url}?ashby_jid=../other`],
    [zafranEmbed.replace('id="ashby_embed"', 'id="ashby_embed" data-jid="18e12d92-d9ec-4388-a6cf-3c62d1369681"'), `${url}?ashby_jid=${id}`],
  ]) {
    const result = ashbyEmbed(html, page);
    assert.equal(result?.postingUrl, undefined);
    assert.match(result!.verificationError!, /unambiguous/);
  }
});

test('ordinary links, comments, vendor mentions and lookalike hosts are not embed evidence', () => {
  for (const html of [`<a href="${board}">Careers</a>`, '<p>Experience with Ashby required.</p>',
    `<!-- ${zafranEmbed} -->`, zafranEmbed.replaceAll('jobs.ashbyhq.com', 'jobs.ashbyhq.com.evil.example'),
    zafranEmbed.replaceAll('https:', 'http:'), zafranEmbed.replaceAll('jobs.ashbyhq.com', 'user@jobs.ashbyhq.com'),
    `<script>const example = '${board}/embed';</script>`]) {
    assert.equal(ashbyEmbed(html, `${url}?ashby_jid=${id}`), null);
  }
});
