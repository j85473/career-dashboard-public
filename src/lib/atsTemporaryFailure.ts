/** An unavailable service or unreadable public bootstrap is not evidence that
 * an employer board has closed. Keep it on a bounded batch retry instead. */
export class AtsTemporaryUnavailableError extends Error {
  constructor(
    readonly platform: string,
    reason: string,
    readonly retryAt: Date | null = null,
    readonly status?: number,
  ) {
    super(`${platform} temporarily unavailable: ${reason}`);
    this.name = 'AtsTemporaryUnavailableError';
  }
}

export function isAtsTemporaryFailure(error: unknown): boolean {
  if (error instanceof AtsTemporaryUnavailableError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /temporarily unavailable:|\bHTTP\s+(?:408|425|5\d\d)\b|\b(?:ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ETIMEDOUT)\b|fetch failed|network is unreachable|timed?\s*out/i.test(message)
    || error instanceof Error && error.name === 'TimeoutError';
}

function retryAfterDate(value: string | null, now: Date): Date | null {
  if (!value) return null;
  const milliseconds = /^\d+$/.test(value.trim()) ? now.getTime() + Number(value) * 1000 : Date.parse(value);
  const result = new Date(milliseconds);
  return Number.isFinite(result.getTime()) && milliseconds > now.getTime() ? result : null;
}

/** Read a small prefix, then release the clone without consuming the caller's
 * body. Do not retain response text, URLs, tokens or employer data in errors. */
async function responsePreview(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '', remaining = 16_384;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      remaining -= Math.min(value.length, remaining);
    }
    return text + decoder.decode();
  } finally {
    // A tee's cancellation can wait for the other reader; never await it.
    void reader.cancel().catch(() => undefined);
  }
}

export function isAtsMaintenancePage(html: string): boolean {
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, ' ').replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const visible = markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const heading = [...markup.matchAll(/<(?:title|h1)\b[^>]*>([\s\S]*?)<\/(?:title|h1)>/gi)]
    .map(match => match[1].replace(/<[^>]*>/g, ' ')).join(' ');
  return /\b(?:service (?:is )?(?:temporarily )?unavailable|bad gateway|gateway timeout|(?:scheduled|unplanned|emergency) maintenance)\b/i.test(heading)
    || /\bworkday (?:is )?(?:currently|temporarily) unavailable\b|\b(?:system|site|service) is (?:currently|temporarily) unavailable\b|\b(?:down|unavailable) for (?:scheduled )?maintenance\b/i.test(visible);
}

/** Apply before parsing a JSON feed or a public HTML configuration page. */
export async function assertAtsServiceAvailable(platform: string, response: Response, now = new Date()): Promise<void> {
  const retryAt = retryAfterDate(response.headers.get('retry-after'), now);
  if (response.status === 408 || response.status === 425 || response.status >= 500 && response.status <= 599) {
    void response.body?.cancel().catch(() => undefined);
    throw new AtsTemporaryUnavailableError(platform, `HTTP ${response.status}`, retryAt, response.status);
  }
  if (response.ok && /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get('content-type') || '')
    && isAtsMaintenancePage(await responsePreview(response))) {
    void response.body?.cancel().catch(() => undefined);
    throw new AtsTemporaryUnavailableError(platform, 'maintenance or service outage page', retryAt, response.status);
  }
}

export function atsTemporaryRetryDelayMs(priorFailures: number, boardKey: string): number {
  const minutes = priorFailures < 1 ? 15 : priorFailures < 2 ? 30 : 60;
  // Stable per-board spread avoids releasing a provider's entire failed cohort
  // at one instant. The maximum remains one hour, including this spread.
  let spread = 0;
  for (const char of boardKey) spread = (spread * 31 + char.charCodeAt(0)) % 60_000;
  return minutes * 60_000 - spread;
}
