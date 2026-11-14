import { createPipelineControlServer } from '../../src/lib/pipelineControlServer';
import { PIPELINE_CONTROL_SOCKET } from '../../src/lib/pipelineServiceClient';
import { startPipeline, stopPipelineProcess, pipelineRunIsActive } from '../../src/lib/pipelineRunner';
import { startLocalPipeline, startExtractionPipeline, stopManualPipelineProcess, manualPipelineMode } from '../../src/lib/pipelineManualRunners';
import { workerLanesDrained } from '../../src/lib/workerDeployment';
import { abortActivePipeline, flushPipelineState } from '../../src/lib/pipelineState';
import { controlPrisma } from '../../src/lib/controlPrisma';
import { prisma } from '../../src/lib/prisma';

async function main() {
  const server = await createPipelineControlServer({
    socketPath: process.env.PIPELINE_CONTROL_SOCKET || PIPELINE_CONTROL_SOCKET,
    release: process.env.ATS_WORKER_RELEASE_ID || 'development',
    start: (scheduled, mode, resume) => mode === 'local' ? startLocalPipeline()
      : mode === 'extraction' ? startExtractionPipeline() : startPipeline(scheduled, { resumeHandoff: resume }),
    abort: () => abortActivePipeline('Pipeline stop requested through its control service.'),
    workState: () => {
      const mode = pipelineRunIsActive() ? 'full' : manualPipelineMode();
      return { running: mode !== null, mode, drained: mode === null || workerLanesDrained() };
    },
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
    // Drain accepted Start commands before aborting their run. Otherwise a
    // concurrent Start could acquire its lock just after the stop signal.
    await Promise.all([stopPipelineProcess(), stopManualPipelineProcess()]);
    await flushPipelineState();
    await Promise.all([prisma.$disconnect(), controlPrisma.$disconnect()]);
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => { void shutdown().catch((error) => { console.error(error); process.exit(1); }); });
  }
  console.log(`Pipeline control ready; worker release ${process.env.ATS_WORKER_RELEASE_ID || 'development'}.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
