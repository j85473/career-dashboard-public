import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PrismaClient } from '../../src/lib/prismaClient';
import { linkedInWorkspace, saveLinkedInDrafts, trackLinkedInDraft } from '../../src/lib/linkedinDraftStore';
import type { LinkedInArticle } from '../../src/lib/linkedinArticles';

// Deliberately separate from DATABASE_URL so these tests cannot select production accidentally.
const url = process.env.LINKEDIN_VERIFY_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/career_linkedin_verify') {
  throw Error('Set LINKEDIN_VERIFY_DATABASE_URL to the local career_linkedin_verify database.');
}
const db = new PrismaClient({ datasourceUrl: url });

test('additive migration preserves history; real transactions prevent repeat drafts and stale-tab copy', async () => {
  try {
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS "LinkedInDraft", "UsedArticle"');
    await db.$executeRawUnsafe('CREATE TABLE "LinkedInDraft" (id TEXT PRIMARY KEY, title TEXT NOT NULL, "postText" TEXT NOT NULL, url TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await db.$executeRawUnsafe('CREATE TABLE "UsedArticle" (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, status TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await db.$executeRawUnsafe(`INSERT INTO "LinkedInDraft" VALUES ('old','Previously posted','Preserve this original post.','https://example.com/old','2026-01-01')`);
    await db.$executeRawUnsafe(`INSERT INTO "UsedArticle" VALUES ('old-use','https://example.com/old','posted','2026-01-02')`);
    const migration = await readFile('prisma/migrations/20261117010000_linkedin_draft_sources/migration.sql', 'utf8');
    for (const sql of migration.split(';').map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(sql);
    const initial = await linkedInWorkspace(db);
    assert.equal(initial.options.length, 0);
    assert.equal(initial.history[0].postText, 'Preserve this original post.');
    assert.equal(new Date(initial.history[0].trackedAt!).toISOString(), '2026-01-02T00:00:00.000Z');

    const article: LinkedInArticle = { title: 'Partner onboarding', url: 'https://example.com/partners', discoveredUrl: 'https://example.com/partners',
      publisher: 'example.com', body: 'The distributor gives resellers one contact for onboarding and orders.', publishedAt: '2026-11-16', retrievedAt: '2026-11-16' };
    const draft = { title: article.title, url: article.url, sourceQuote: article.body,
      postText: 'The distributor is assigning one named contact to each reseller for onboarding and order questions. That makes the first step clearer when an order stalls. Technical support will still need a defined handoff.' };
    const writes = await Promise.allSettled([saveLinkedInDrafts([draft], [article], 'test doctrine', db), saveLinkedInDrafts([draft], [article], 'test doctrine', db)]);
    assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(await db.linkedInDraft.count(), 2);
    const option = (await linkedInWorkspace(db)).options[0];
    const copy = await trackLinkedInDraft({ draftId: option.id, action: 'copy' }, db);
    assert.ok('copyText' in copy && copy.copyText.includes(draft.postText));
    await assert.rejects(trackLinkedInDraft({ draftId: option.id, action: 'copy' }, db), /already copied/);
    const copiedAt = (await db.linkedInDraft.findUniqueOrThrow({ where: { id: option.id } })).copiedAt!.toISOString();
    await trackLinkedInDraft({ draftId: option.id, action: 'copy', repeatCopiedAt: copiedAt }, db);
    await trackLinkedInDraft({ draftId: option.id, action: 'posted' }, db);
    await trackLinkedInDraft({ draftId: option.id, action: 'posted' }, db);
    await assert.rejects(trackLinkedInDraft({ draftId: option.id, action: 'copy' }, db), /already posted/);
    await assert.rejects(trackLinkedInDraft({ draftId: option.id, action: 'passed' }, db), /already posted/);
    assert.equal((await linkedInWorkspace(db)).options.length, 0);
    assert.equal((await linkedInWorkspace(db)).history.filter(d => d.status === 'posted').length, 2);
    await assert.rejects(saveLinkedInDrafts([draft], [article], 'doctrine', db), /already in your history/);
    const final = await db.linkedInDraft.findUniqueOrThrow({ where: { id: option.id } });
    assert.equal((final.source as { body: string }).body, article.body);
    assert.equal(final.postText, draft.postText);
  } finally { await db.$disconnect(); }
});
