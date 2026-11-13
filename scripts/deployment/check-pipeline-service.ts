import { requestPipelineService, PIPELINE_CONTROL_PROTOCOL } from '../../src/lib/pipelineServiceClient';

async function main() {
  const result = await requestPipelineService('/health');
  if (result.status !== 200 || result.body.ok !== true || result.body.protocol !== PIPELINE_CONTROL_PROTOCOL
    || result.body.release !== process.argv[2]) throw new Error('Pipeline service does not match the pinned worker release.');
  console.log(JSON.stringify(result.body));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
