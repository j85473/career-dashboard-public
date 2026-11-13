import { createServer } from 'node:http';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { PIPELINE_CONTROL_PROTOCOL, requestPipelineService } from './pipelineServiceClient';

/** Private same-user control channel; the worker never binds a TCP port. */
export async function createPipelineControlServer(options: {
  socketPath: string;
  release: string;
  start: (scheduled: boolean, mode: 'full' | 'local' | 'extraction') => Promise<Response>;
  abort: () => boolean;
}) {
  try {
    const existing = await lstat(options.socketPath);
    if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('Refusing to replace another owner\'s control path.');
    try {
      await requestPipelineService('/health', {}, options.socketPath, 1_000);
      throw new Error('Another pipeline control server is already listening.');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ECONNREFUSED' && code !== 'ENOENT') throw error;
    }
    await unlink(options.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let closing = false;
  const server = createServer(async (req, res) => {
    const reject = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    };
    try {
      if (closing) { reject(503, 'Pipeline service is stopping.'); return; }
      if (req.method === 'GET' && req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, protocol: PIPELINE_CONTROL_PROTOCOL, release: options.release, pid: process.pid }));
        return;
      }
      if (req.method !== 'POST' || !['/start', '/abort'].includes(req.url || '')) {
        reject(404, 'Unknown pipeline control command.'); return;
      }
      let payload = '';
      for await (const chunk of req) {
        payload += chunk;
        if (payload.length > 1_024) { reject(413, 'Pipeline control command is too large.'); return; }
      }
      const input: unknown = JSON.parse(payload || '{}');
      if (!input || typeof input !== 'object' || Array.isArray(input)) { reject(400, 'Invalid pipeline control command.'); return; }
      const scheduled = (input as { scheduled?: unknown }).scheduled;
      const mode = (input as { mode?: unknown }).mode ?? 'full';
      if (req.url === '/start' && typeof scheduled !== 'boolean') { reject(400, 'Start requires a scheduled boolean.'); return; }
      if (typeof mode !== 'string' || !['full', 'local', 'extraction'].includes(mode) || (scheduled && mode !== 'full')) {
        reject(400, 'Invalid pipeline run mode.'); return;
      }
      const result = req.url === '/start'
        ? await options.start(scheduled as boolean, mode as 'full' | 'local' | 'extraction')
        : Response.json({ aborted: options.abort() });
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(await result.text());
    } catch (error) {
      res.writeHead(error instanceof SyntaxError ? 400 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Pipeline control request failed.' }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  await chmod(options.socketPath, 0o600);
  return {
    async close() {
      closing = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      // Node removes its Unix socket on close. Never unlink a replacement.
    },
  };
}
