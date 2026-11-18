import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { assertDraftReview, buildLinkedInPrompt, generateLinkedInDrafts, loadWritingDoctrine, parseGeneratedDrafts } from '../../src/lib/linkedinPostGeneration';
import type { LinkedInArticle } from '../../src/lib/linkedinArticles';

const quote = 'The distributor gives resellers one named contact for onboarding and order problems.';
const article: LinkedInArticle = { title: 'Distributor changes partner support', url: 'https://example.com/channel',
  discoveredUrl: 'https://example.com/channel', publisher: 'example.com', publishedAt: '2026-11-16T12:00:00Z', retrievedAt: '2026-11-16T12:30:00Z',
  body: `${quote}\n\nThe new partner program keeps technical support separate from account planning. Resellers can still use the existing ordering system.` };
const draft = { title: 'One contact for order problems', url: article.url, sourceQuote: quote,
  postText: 'The distributor is giving resellers one named contact for onboarding and order problems. That creates a clearer place to start when an order stalls. I would want to know how that contact hands off technical issues, since technical support remains separate.' };
const rawDraft = { ...draft, sourceParagraph: 0 };
const reviewed = { reviews: [{ url: article.url, relevant: true, supported: true, voiceMatches: true, distinct: true }] };

test('writer receives article bodies and the complete doctrine in both writing and review', async () => {
  const calls: { prompt: string; doctrine: string }[] = [];
  const doctrine = 'Writing as Joe Doctrine v1.3.2\nFull fixture instructions including the end.\n# 14. Final Operating Rule';
  const result = await generateLinkedInDrafts([article], ['A different past story.'], { doctrine: async () => doctrine, model: async (prompt, rules) => {
    calls.push({ prompt, doctrine: rules });
    return JSON.stringify(calls.length === 1 ? { posts: [rawDraft] } : reviewed);
  } });
  assert.equal(result.drafts.length, 1);
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(call.doctrine, doctrine); assert.ok(call.prompt.includes(quote)); }
  assert.match(calls[1].prompt, /A different past story/);
  assert.match(buildLinkedInPrompt([article]), /untrusted evidence/);
});

test('writer or reviewer failure returns an error without canned drafts', async () => {
  await assert.rejects(generateLinkedInDrafts([article], [], { doctrine: async () => 'rules', model: async () => { throw Error('Provider unavailable'); } }), /Provider unavailable/);
  let calls = 0;
  await assert.rejects(generateLinkedInDrafts([article], [], { doctrine: async () => 'rules', model: async () => {
    if (++calls === 1) return JSON.stringify({ posts: [rawDraft] });
    throw Error('Review unavailable');
  } }), /Review unavailable/);
});

test('draft parsing rejects unsupported source passages, invented URLs and repeated copy', () => {
  assert.deepEqual(parseGeneratedDrafts(JSON.stringify({ posts: [rawDraft] }), [article]), [draft]);
  assert.throws(() => parseGeneratedDrafts(JSON.stringify({ posts: [{ ...rawDraft, sourceParagraph: 500 }] }), [article]), /paragraph IDs/);
  assert.throws(() => parseGeneratedDrafts(JSON.stringify({ posts: [{ ...rawDraft, url: 'https://invented.example/' }] }), [article]), /unverified/);
  assert.throws(() => parseGeneratedDrafts(JSON.stringify({ posts: [rawDraft] }), [article], [draft.postText]), /repeats/);
  const second = { ...article, url: 'https://example.com/second' };
  assert.throws(() => parseGeneratedDrafts(JSON.stringify({ posts: [rawDraft, { ...rawDraft, url: second.url }] }), [article, second]), /repeats/);
  assert.throws(() => parseGeneratedDrafts(JSON.stringify({ posts: [] }), [article]), /every read article/);
});

test('review must cover every article and approve evidence, relevance, voice and novelty', () => {
  assertDraftReview(JSON.stringify(reviewed), [draft]);
  for (const field of ['relevant', 'supported', 'voiceMatches', 'distinct']) {
    assert.throws(() => assertDraftReview(JSON.stringify({ reviews: [{ ...reviewed.reviews[0], [field]: false }] }), [draft]), /did not pass/);
  }
  assert.throws(() => assertDraftReview('{"reviews":[]}', [draft]), /incomplete/);
  assert.throws(() => assertDraftReview(JSON.stringify({ reviews: [{ ...reviewed.reviews[0], url: 'https://other.example' }] }), [draft]), /did not match/);
});


test('private bundled doctrine loads without truncation', { skip: !existsSync('data/writing/writing-as-joe-v1.3.2.md') }, async () => {
  assert.equal(await loadWritingDoctrine(), await readFile('data/writing/writing-as-joe-v1.3.2.md', 'utf8'));
});

test('one rejected draft is rewritten from the source and reviewed, with no unbounded retries', async () => {
  const prompts: string[] = [];
  const result = await generateLinkedInDrafts([article], [], { doctrine: async () => 'rules', model: async prompt => {
    prompts.push(prompt);
    if (prompts.length === 1) return JSON.stringify({ posts: [{ ...rawDraft, sourceParagraph: 500 }] });
    return JSON.stringify(prompts.length === 2 ? { posts: [rawDraft] } : reviewed);
  } });
  assert.equal(result.drafts.length, 1);
  assert.match(prompts[1], /previous attempt/);
  assert.equal(prompts.length, 3);
  let attempts = 0;
  await assert.rejects(generateLinkedInDrafts([article], [], { doctrine: async () => 'rules', model: async () => {
    attempts++; return '{"posts":[]}';
  } }), /after a rewrite/);
  assert.equal(attempts, 2);
});
