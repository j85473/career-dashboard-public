import { createHash } from 'node:crypto';
import { prisma } from './prisma';
import type { Prisma, PrismaClient } from './prismaClient';
import { articleAlreadySeen, articleKey, draftViews, sameArticle, similarPosts } from './linkedinDraftPolicy';
import type { LinkedInArticle } from './linkedinArticles';
import type { LinkedInDraftOption } from './linkedinPostGeneration';

type Reader = Pick<Prisma.TransactionClient, 'linkedInDraft' | 'usedArticle'>;
export class LinkedInActionError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export async function readLinkedInHistory(db: Reader = prisma) {
  const [drafts, used] = await Promise.all([
    db.linkedInDraft.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    db.usedArticle.findMany({ orderBy: { updatedAt: 'desc' } }),
  ]);
  return { drafts, used };
}

export async function linkedInWorkspace(db: Reader = prisma) {
  const { drafts, used } = await readLinkedInHistory(db);
  const views = draftViews(drafts, used).map(draft => {
    const source = draft.source as { title?: string; publisher?: string; publishedAt?: string; retrievedAt?: string; sourceQuote?: string } | null;
    return { ...draft, source: source ? { title: source.title, publisher: source.publisher, publishedAt: source.publishedAt,
      retrievedAt: source.retrievedAt, sourceQuote: source.sourceQuote } : null };
  });
  const active = views.filter(d => d.status === 'draft');
  return { options: active.slice(0, 3), remaining: active.length, history: views.filter(d => d.status !== 'draft'),
    trackedArticles: used.filter(u => ['posted', 'passed'].includes(u.status) && !drafts.some(d => sameArticle(d.url, u.url, true))) };
}

async function locked<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('career-dashboard:linkedin-drafts', 0))`;
    return work(tx);
  }, { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 });
}

export async function saveLinkedInDrafts(drafts: LinkedInDraftOption[], articles: LinkedInArticle[], doctrine: string, db: PrismaClient = prisma) {
  return locked(db, async tx => {
    const current = await readLinkedInHistory(tx);
    const saved: LinkedInDraftOption[] = [];
    for (const draft of drafts) {
      const article = articles.find(a => a.url === draft.url);
      if (!article) throw Error('A draft is missing its read source.');
      if (articleAlreadySeen(article.url, current.drafts, current.used)
        || articleAlreadySeen(article.discoveredUrl, current.drafts, current.used)
        || saved.some(d => sameArticle(d.url, draft.url))
        || [...current.drafts, ...saved].some(d => similarPosts(d.postText, draft.postText))) {
        throw new LinkedInActionError('This article or post is already in your history. Reload to see the saved options.');
      }
      saved.push(draft);
    }
    for (const draft of drafts) {
      const article = articles.find(a => a.url === draft.url)!;
      await tx.linkedInDraft.create({ data: { title: draft.title, postText: draft.postText, url: article.url,
        source: { ...article, sourceQuote: draft.sourceQuote, doctrineVersion: '1.3.2',
          doctrineSha256: createHash('sha256').update(doctrine).digest('hex') } } });
    }
    return linkedInWorkspace(tx);
  });
}

export async function trackLinkedInDraft(input: { draftId: string; action: 'posted' | 'passed' | 'copy'; repeatCopiedAt?: string }, db: PrismaClient = prisma) {
  return locked(db, async tx => {
    const current = await readLinkedInHistory(tx);
    const draft = current.drafts.find(d => d.id === input.draftId);
    if (!draft) throw new LinkedInActionError('This saved draft was not found. Reload the tab.', 404);
    const view = draftViews(current.drafts, current.used).find(d => d.id === draft.id)!;
    if (view.status === input.action) return { success: true, ...(await linkedInWorkspace(tx)) };
    if (view.status !== 'draft') throw new LinkedInActionError(`This draft is already ${view.status === 'legacy' ? 'an archived template' : view.status}. Reload to see your history.`);
    if (input.action === 'copy') {
      if (draft.copiedAt && input.repeatCopiedAt !== draft.copiedAt.toISOString()) {
        throw new LinkedInActionError('This draft was already copied. Check whether you posted it before copying it again.');
      }
      await tx.linkedInDraft.update({ where: { id: draft.id }, data: { copiedAt: new Date() } });
      return { success: true, copyText: `${draft.postText}\n\n${draft.url}`, ...(await linkedInWorkspace(tx)) };
    }
    await tx.usedArticle.upsert({ where: { url: articleKey(draft.url) },
      create: { url: articleKey(draft.url), status: input.action }, update: { status: input.action } });
    return { success: true, ...(await linkedInWorkspace(tx)) };
  });
}
