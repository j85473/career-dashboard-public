import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { pendingCanonicalReview } from '@/lib/canonicalMergeReview';
import { listCombinedCopies } from '@/lib/sameJobConsolidation';

/** Copies of this job from other sources that were combined into this card. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const [copies, matchingCards] = await Promise.all([listCombinedCopies(prisma, id), pendingCanonicalReview(prisma, id)]);
    return NextResponse.json({ copies, matchingCards });
  } catch (error) {
    console.error('Failed to list combined copies:', error);
    return NextResponse.json({ error: 'Combined copies could not be loaded.' }, { status: 500 });
  }
}
