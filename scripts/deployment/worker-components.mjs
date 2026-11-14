import path from 'node:path';

export const COMPONENT_PROTOCOL = 1;
const unit = (name) => `career-dashboard-${name}`;
export const WORKER_COMPONENTS = {
  pipeline: { strategy: 'pipeline', units: [unit('pipeline'), unit('scheduler')],
    entries: ['scripts/workers/pipeline-coordinator.ts', 'scripts/workers/ats-acquisition.ts', 'scripts/cron/run_pipeline.ts'] },
  acquisition: { strategy: 'acquisition', units: [unit('acquisition')], entries: ['scripts/workers/ats-remote-continuation.ts'] },
  'public-http': { strategy: 'turn', units: [unit('public-http')], entries: ['scripts/sweep_public_ats_boards.ts'] },
  browser: { strategy: 'turn', units: [unit('canonical-resolver'), unit('gusto'), unit('public-boards')],
    entries: ['scripts/resolve_himalayas_employer_urls.ts', 'scripts/resolve_himalayas_browser_urls.ts',
      'scripts/sweep_gusto_boards.ts', 'scripts/sweep_public_ats_boards.ts'] },
  'canonical-api': { strategy: 'turn', units: [unit('canonical-api')],
    entries: ['scripts/retry_aggregator_intake.ts', 'scripts/resolve_aggregator_ats_matches.ts'] },
  admission: { strategy: 'turn', units: [unit('first-collections'), unit('rotation-balance')],
    entries: ['scripts/control_ats_first_collections.ts', 'scripts/balance_ats_rotation.ts'] },
  watchdog: { strategy: 'turn', units: [unit('watchdog')], entries: ['scripts/ats_pipeline_watchdog.ts'] },
  'web-discovery': { strategy: 'turn', units: [unit('web-discovery')], entries: ['scripts/crawl_ats_boards.ts'] },
  // Discovery audits, storage operations and backups can run for hours. They
  // stay pinned, but their changes still require the coordinated release.
  platform: { strategy: 'coordinated', units: [unit('discovery'), unit('discovery-audit'), unit('board-pruning'),
    unit('storage-monitor'), unit('crawl-archive'), unit('backup'), unit('worker-recovery')], entries: ['scripts/audit_ats_common_crawl.ts',
      'scripts/review_ats_board_pruning.ts', 'scripts/deployment/archive-crawls.ts', 'scripts/deployment/dispose-crawls.ts',
      'scripts/deployment/snapshot-backup-runtime.mjs'] },
};

export function componentForUnit(filename) {
  const name = path.basename(filename).replace(/\.(service|timer)$/, '');
  return Object.keys(WORKER_COMPONENTS).find((key) => WORKER_COMPONENTS[key].units.includes(name));
}

export function deploymentPaths(root = '') {
  const at = (name) => path.join(root, name);
  return { releases: at('/opt/career-dashboard-releases'), web: at('/opt/career-dashboard'),
    workers: at('/opt/career-dashboard-workers'), pins: at('/opt/career-dashboard-worker-releases'),
    config: at('/etc/career-dashboard'), units: at('/etc/systemd/system'),
    runtime: at('/var/lib/career-dashboard/data/runtime'), state: at('/var/lib/career-dashboard/deployment-state') };
}

export function renderWorkerUnit(source, component, paths = deploymentPaths()) {
  if (!WORKER_COMPONENTS[component]) throw new Error('Unknown worker component.');
  const alias = path.join(paths.pins, component);
  const turnCondition = WORKER_COMPONENTS[component].strategy === 'turn'
    ? `\n[Unit]\nConditionPathExists=!${path.join(paths.runtime, 'worker-drain', `${component}.json`)}\n` : '';
  return source.replaceAll('/opt/career-dashboard-workers', alias)
    + turnCondition + `\n[Service]\nEnvironmentFile=${path.join(paths.config, 'worker-releases', `${component}.env`)}\n`;
}

// These interfaces govern mixed-version writes and ownership. Changes use the
// full migration/quiescence path; a fingerprint never changes a saved score.
export function coordinationInput(name) {
  return /^(prisma\/|vendor\/|data\/|config\/)/.test(name)
    || (name.startsWith('docs/') && name !== 'docs/M70_PRODUCTION_OPERATIONS.md')
    || ['package.json', 'package-lock.json', '.nvmrc', 'tsconfig.json'].includes(name)
    || (name.startsWith('scripts/deployment/') && !componentForUnit(name))
    || ['src/lib/pipelineState.ts', 'src/lib/pipelineServiceClient.ts', 'src/lib/pipelineControlServer.ts',
      'src/lib/workerDeployment.ts', 'src/lib/ingestionControl.ts', 'src/lib/atsAcquisitionCoordination.ts',
      'src/lib/ingestionState.ts', 'src/lib/atsAcquisition.ts', 'src/lib/atsAcquisitionPayload.ts',
      'src/lib/atsJobEnrichment.ts', 'src/lib/atsProviderRequest.ts', 'src/lib/atsAcquisitionCompatibility.ts',
      'src/lib/atsAcquisitionLedger.ts', 'src/lib/storagePressure.ts'].includes(name)
    || /^src\/lib\/(?:scoring|score|manualScoring|canonicalResume)/.test(name);
}
