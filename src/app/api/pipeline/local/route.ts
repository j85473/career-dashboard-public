import { requestPipelineService } from '@/lib/pipelineServiceClient';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST() {
  if (process.env.PIPELINE_EXECUTION_MODE === 'service') {
    try {
      const result = await requestPipelineService('/start', { scheduled: false, mode: 'local' });
      return Response.json(result.body, { status: result.status });
    } catch {
      return Response.json({ error: 'Pipeline service is unavailable. Please retry shortly.' }, { status: 503 });
    }
  }
  const { startLocalPipeline } = await import('@/lib/pipelineManualRunners');
  return startLocalPipeline();
}
