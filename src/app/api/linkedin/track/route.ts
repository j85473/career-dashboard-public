import { NextResponse } from 'next/server';
import { LinkedInActionError, trackLinkedInDraft } from '@/lib/linkedinDraftStore';

export async function POST(req: Request) {
  let input;
  try { input = await req.json(); } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }); }
  if (!input || typeof input.draftId !== 'string' || !['posted', 'passed', 'copy'].includes(input.action)
    || (input.repeatCopiedAt !== undefined && typeof input.repeatCopiedAt !== 'string')) {
    return NextResponse.json({ error: 'A saved draft and valid action are required. Reload the LinkedIn tab.' }, { status: 400 });
  }
  try { return NextResponse.json(await trackLinkedInDraft(input)); }
  catch (error) {
    return NextResponse.json({ error: error instanceof LinkedInActionError ? error.message : 'Could not save that action. Your draft is still available; try again.' },
      { status: error instanceof LinkedInActionError ? error.status : 500 });
  }
}
