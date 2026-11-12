export const dynamic = 'force-dynamic';

/** Read-only deployment check; never cache an old release in Safari or a proxy. */
export function GET() {
  return Response.json({ version: process.env.NEXT_PUBLIC_DASHBOARD_BUILD_VERSION || null }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
