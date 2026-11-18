import { NextResponse } from 'next/server';

export async function GET() {
  // Legacy results lack read-source evidence. Never harvest them or delete saved drafts.
  return NextResponse.json({ message: 'Posts are generated directly. Reload the LinkedIn tab to see saved drafts and history.' });
}
