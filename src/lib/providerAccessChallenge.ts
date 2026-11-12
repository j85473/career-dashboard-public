/** Explicit edge challenge evidence takes precedence over generic 403/429 labels. */
export class ProviderAccessChallengeError extends Error {
  constructor(source: string, status: number, protection: 'Cloudflare' | 'Vercel') {
    super(`${source} access challenge (HTTP ${status}, ${protection}); automated feed access requires browser verification`);
    this.name = 'ProviderAccessChallengeError';
  }
}

export async function requireUnchallengedProviderResponse(source: string, response: Response): Promise<void> {
  const protection = response.headers.get('cf-mitigated') === 'challenge' ? 'Cloudflare'
    : response.headers.get('x-vercel-mitigated') === 'challenge' ? 'Vercel' : null;
  if (!protection) return;
  await response.body?.cancel();
  throw new ProviderAccessChallengeError(source, response.status, protection);
}
