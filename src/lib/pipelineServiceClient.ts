import { request } from 'node:http';

export const PIPELINE_CONTROL_PROTOCOL = 2;
export const PIPELINE_CONTROL_SOCKET = '/var/lib/career-dashboard/data/runtime/pipeline-control.sock';

export function requestPipelineService(
  pathname: '/start' | '/resume' | '/abort' | '/health',
  body: Record<string, unknown> = {},
  socketPath = process.env.PIPELINE_CONTROL_SOCKET || PIPELINE_CONTROL_SOCKET,
  timeoutMs = 10_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, result?: { status: number; body: Record<string, unknown> }) => {
      clearTimeout(deadline);
      if (error) reject(error); else resolve(result!);
    };
    const payload = JSON.stringify(body);
    const req = request({ socketPath, path: pathname, method: pathname === '/health' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        data += chunk;
        if (data.length > 16_384) res.destroy(new Error('Pipeline control response is too large.'));
      });
      res.on('error', (error) => finish(error));
      res.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(data);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid pipeline response.');
          finish(undefined, { status: res.statusCode || 500, body: parsed as Record<string, unknown> });
        } catch (error) { finish(error); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Pipeline control request timed out.')), timeoutMs);
    req.on('error', (error) => finish(error));
    req.end(payload);
  });
}
