import { runCronMain, runPipelineAndWait } from './http';
import { requestPipelineService } from '../../src/lib/pipelineServiceClient';

runCronMain(async () => {
  if (process.env.PIPELINE_EXECUTION_MODE !== 'service') return runPipelineAndWait();
  // The coordinator owns the run; a scheduler tick starts it and exits. It
  // neither needs the web server nor waits forever for a continuous pipeline.
  const result = await requestPipelineService('/start', { scheduled: true });
  if (result.status === 400 && result.body.message === 'Pipeline already running') return;
  if (result.status !== 200) throw new Error(`Pipeline service returned ${result.status}: ${JSON.stringify(result.body)}`);
  console.log(JSON.stringify(result.body));
});
