import { isScheduledPipelineRequest } from '@/lib/apiAuth';
import { requestPipelineService } from '@/lib/pipelineServiceClient';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const scheduled = isScheduledPipelineRequest(request);
  if (process.env.PIPELINE_EXECUTION_MODE === 'service') {
    try {
      const result = await requestPipelineService('/start', { scheduled });
      return Response.json(result.body, { status: result.status });
    } catch {
      // A failed control connection must never launch a second, web-owned run.
      return Response.json({ error: 'Pipeline service is unavailable. Please retry shortly.' }, { status: 503 });
    }
  }
  // Local development retains its existing inline runner. Production always
  // uses the separately supervised service, including after a web rollback.
  const { startPipeline } = await import('@/lib/pipelineRunner');
  return startPipeline(scheduled);
}
