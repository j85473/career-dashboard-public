import { NextResponse } from 'next/server';
import { discoverLinkedInArticles } from '@/lib/linkedinArticles';
import { articleAlreadySeen } from '@/lib/linkedinDraftPolicy';
import { generateLinkedInDrafts, loadWritingDoctrine } from '@/lib/linkedinPostGeneration';
import { linkedInWorkspace, readLinkedInHistory, saveLinkedInDrafts, LinkedInActionError } from '@/lib/linkedinDraftStore';

export async function GET() {
  try { return NextResponse.json(await linkedInWorkspace(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'Could not load your saved drafts and posting history.' }, { status: 500 }); }
}

let generation: Promise<Awaited<ReturnType<typeof saveLinkedInDrafts>>> | null = null;

async function generate() {
  const doctrine = await loadWritingDoctrine();
  const history = await readLinkedInHistory();
  const articles = await discoverLinkedInArticles({ alreadySeen: url => articleAlreadySeen(url, history.drafts, history.used) });
  const result = await generateLinkedInDrafts(articles, history.drafts.map(d => d.postText), { doctrine: async () => doctrine });
  return saveLinkedInDrafts(result.drafts, articles, result.doctrine);
}

export async function POST() {
  try {
    // Coalesce double clicks here; the database transaction also fences other processes.
    if (!generation) generation = generate().finally(() => { generation = null; });
    return NextResponse.json(await generation);
  } catch (error) {
    console.error('LinkedIn generation failed:', error);
    return NextResponse.json({ error: error instanceof Error && !error.message.includes('API key')
      ? error.message : 'The post writer is unavailable. Your saved drafts are unchanged.' },
    { status: error instanceof LinkedInActionError ? error.status : 502 });
  }
}
