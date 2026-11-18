import assert from 'node:assert/strict';
import test from 'node:test';
import { articleAlreadySeen, articleKey, draftViews, sameArticle, similarPosts, type DraftRecord } from '../../src/lib/linkedinDraftPolicy';

const record = (id: string, extra: Partial<DraftRecord> = {}): DraftRecord => ({ id, title: id, postText: `Distinct draft ${id}.`, url: `https://example.com/${id}`, createdAt: new Date('2026-11-16'), ...extra });

test('posted and passed drafts remain history after a reload, including older than fifty records', () => {
  const drafts = [record('posted'), record('passed'), record('fresh')];
  const used = Array.from({ length: 70 }, (_, i) => ({ url: `https://example.com/old-${i}`, status: 'posted', createdAt: new Date() }));
  used.push({ url: drafts[0].url, status: 'posted', createdAt: new Date(0) }, { url: drafts[1].url, status: 'passed', createdAt: new Date(0) });
  assert.deepEqual(draftViews(drafts, used).filter(d => d.status === 'draft').map(d => d.id), ['fresh']);
  assert.equal(articleAlreadySeen(drafts[0].url, [], used), true);
  assert.equal(articleAlreadySeen(drafts[2].url, drafts, []), true);
});

test('URL identity strips trackers but preserves case-sensitive paths and handles old lowercased tracking', () => {
  assert.equal(articleKey('http://www.example.com/Story/?utm_source=news#section'), 'https://example.com/Story');
  assert.equal(sameArticle('https://example.com/Story', 'https://example.com/story'), false);
  assert.equal(sameArticle('https://example.com/Story', 'https://example.com/story', true), true);
  const draft = record('legacy', { url: 'https://news.google.com/rss/articles/CaSeSensitive?oc=5' });
  assert.equal(draftViews([draft], [{ url: draft.url.toLowerCase(), status: 'posted', createdAt: new Date() }])[0].status, 'posted');
});

test('templates and duplicate articles are retained in history, not copyable options', () => {
  const text = 'Channel growth is operational before it is strategic.\nA recent article adds a useful signal: example';
  const views = draftViews([record('template', { postText: text }), record('a'), record('b', { url: 'https://example.com/a?utm_source=other' })], []);
  assert.equal(views.find(d => d.id === 'template')?.status, 'legacy');
  assert.equal(views.filter(d => d.status === 'draft').length, 1);
  assert.equal(views.filter(d => d.status === 'duplicate').length, 1);
  assert.equal(views.length, 3);
});

test('posted status wins over a conflicting legacy pass and copied state is retained', () => {
  const draft = record('a', { copiedAt: new Date() });
  const views = draftViews([draft], ['passed', 'posted'].map(status => ({ url: draft.url, status, createdAt: new Date() })));
  assert.equal(views[0].status, 'posted');
  assert.equal(views[0].copiedAt, draft.copiedAt);
});

test('near-identical text is caught even when URLs differ', () => {
  const original = 'A reseller needs one named contact for onboarding and order problems. The program should explain how that person hands off technical issues and how the reseller can follow the progress of an unresolved order.';
  assert.equal(similarPosts(original, original.replace('A reseller', 'Every reseller')), true);
  assert.equal(draftViews([record('new', { postText: original }), record('old', { postText: original })], [{ url: 'https://example.com/old', status: 'posted', createdAt: new Date() }]).find(d => d.id === 'new')?.status, 'duplicate');
});
