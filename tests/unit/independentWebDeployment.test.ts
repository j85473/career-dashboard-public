import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
// Repository-owned executable policy is also consumed by deployment.
import { workerInputsHash, readManifest } from '../../scripts/deployment/worker-release-manifest.mjs';
import { workerEnvironmentFingerprint } from '../../scripts/deployment/worker-environment-fingerprint.mjs';

const oid = 'a'.repeat(40);
function tree(files: Record<string, string>) {
  return Object.entries(files).map(([name, revision]) => `100644 blob ${revision}\t${name}\0`).join('');
}

test('web compatibility recognizes interface changes but protects backend, evidence, dependencies and unknown inputs', () => {
  const baseline = { 'src/components/Dashboard.tsx': oid, 'src/app/globals.css': oid, 'src/lib/pipelineRunner.ts': oid,
    'src/app/api/jobs/route.ts': oid, 'package-lock.json': oid, 'prisma/schema.prisma': oid,
    'docs/Candidate_Evidence_Inventory_-_Core_v1.md': oid, 'scripts/deployment/m70/career-dashboard-pipeline.service': oid,
    'data/scoring-policy.json': oid, 'new-runtime-input.txt': oid };
  const fingerprint = workerInputsHash(tree(baseline));
  for (const file of Object.keys(baseline)) {
    const next = workerInputsHash(tree({ ...baseline, [file]: 'b'.repeat(40) }));
    assert.equal(next === fingerprint, ['src/components/Dashboard.tsx', 'src/app/globals.css'].includes(file), file);
  }
  assert.notEqual(workerInputsHash(tree({ ...baseline, 'scripts/new-worker.ts': oid })), fingerprint);
  const { 'src/lib/pipelineRunner.ts': removed, ...deleted } = baseline;
  assert.equal(removed, oid);
  assert.notEqual(workerInputsHash(tree(deleted)), fingerprint);
});

test('missing, malformed or mismatched release proof refuses independent activation', () => {
  const directory = mkdtempSync('/tmp/cd-manifest-');
  try {
    assert.throws(() => readManifest(directory));
    writeFileSync(path.join(directory, '.release-id'), oid);
    writeFileSync(path.join(directory, '.worker-release.json'), JSON.stringify({ version: 1, release: 'b'.repeat(40), inputsHash: 'c'.repeat(64) }));
    assert.throws(() => readManifest(directory), /Unverified/);
    writeFileSync(path.join(directory, '.worker-release.json'), JSON.stringify({ version: 1, release: oid, inputsHash: 'c'.repeat(64) }));
    assert.equal(readManifest(directory).release, oid);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('changed worker settings refuse independence, while a web release cannot change the worker identity', () => {
  const directory = mkdtempSync('/tmp/cd-worker-env-');
  try {
    writeFileSync(path.join(directory, 'runtime.env'), 'EXAMPLE_SETTING=one\n');
    writeFileSync(path.join(directory, 'acquisition-release.env'), `ATS_WORKER_RELEASE_ID=${oid}\n`);
    const original = workerEnvironmentFingerprint(directory);
    writeFileSync(path.join(directory, 'acquisition-release.env'), `ATS_WORKER_RELEASE_ID=${'b'.repeat(40)}\n`);
    assert.equal(workerEnvironmentFingerprint(directory), original, 'identity is checked separately against the pinned release');
    writeFileSync(path.join(directory, 'optional-worker.env'), 'EXAMPLE_SETTING=two\n');
    assert.notEqual(workerEnvironmentFingerprint(directory), original);
    rmSync(path.join(directory, 'optional-worker.env'));
    writeFileSync(path.join(directory, 'runtime.env'), 'EXAMPLE_SETTING=three\n');
    assert.notEqual(workerEnvironmentFingerprint(directory), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const restartSucceeds of [false, true]) {
  test(`coordinated activation ${restartSucceeds ? 'records adopted settings after workers restart' : 'preserves the baseline when worker restart fails'}`, () => {
    const stage = mkdtempSync('/tmp/cd-env-adoption-');
    const baselineFile = path.join(stage, '.worker-environment.sha256');
    const baseline = 'a'.repeat(64) + '\n';
    const candidate = 'b'.repeat(64);
    writeFileSync(baselineFile, baseline);
    const activation = readFileSync(path.resolve('scripts/deployment/activate-m70.sh'), 'utf8');
    const completion = activation.slice(activation.lastIndexOf('\nrestart_background\n'), activation.lastIndexOf('\ntrap - ERR'));
    try {
      const result = spawnSync('bash', ['-c', `
set -Eeuo pipefail
MODE=normal; PIPELINE_NEW=0; WORKER_RECOVERY_NEW=0; CANONICAL_API_NEW=0; PUBLIC_BOARDS_NEW=0; PUBLIC_BOARDS=0; PUBLIC_HTTP_NEW=0
systemctl() { return 0; }
restart_background() { [[ "$RESTART_SUCCEEDS" == 1 ]]; }
${completion}
`], { encoding: 'utf8', env: { ...process.env, STAGE: stage, WORKER_ENVIRONMENT: candidate, RESTART_SUCCEEDS: restartSucceeds ? '1' : '0' } });
      assert.equal(result.status, restartSucceeds ? 0 : 1, result.stderr + result.stdout);
      assert.equal(readFileSync(baselineFile, 'utf8'), restartSucceeds ? candidate + '\n' : baseline);
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
}

for (const webSwapped of [false, true]) {
  test(`coordinated rollback restores independently pinned workers and environment ${webSwapped ? 'after' : 'before'} the web switch`, () => {
    const directory = mkdtempSync('/tmp/cd-full-rollback-');
    const old = path.join(directory, 'old-web'), stage = path.join(directory, 'candidate');
    const priorWorkers = path.join(directory, 'old-workers'), workers = path.join(directory, 'workers');
    const app = path.join(directory, 'app'), config = path.join(directory, 'config');
    for (const root of [old, stage, priorWorkers]) mkdirSync(path.join(root, 'scripts/deployment/m70'), { recursive: true });
    mkdirSync(config);
    writeFileSync(path.join(priorWorkers, 'scripts/deployment/m70/career-dashboard-pipeline.service'), 'prior-worker-unit');
    writeFileSync(path.join(old, 'scripts/deployment/m70/career-dashboard.service'), 'prior-web-unit');
    writeFileSync(path.join(config, 'acquisition-release.env'), 'candidate');
    writeFileSync(path.join(config, 'acquisition-release.env.previous'), 'prior-worker');
    symlinkSync(webSwapped ? stage : old, app); symlinkSync(stage, workers);
    const activation = readFileSync(path.resolve('scripts/deployment/activate-m70.sh'), 'utf8');
    let recovery = activation.slice(activation.indexOf('recover() {'), activation.indexOf('trap recover ERR'));
    recovery = recovery.replaceAll('/etc/career-dashboard', config)
      .replaceAll('/etc/systemd/system', path.join(directory, 'units'))
      .replaceAll('/usr/local/sbin', path.join(directory, 'sbin'));
    const trace = path.join(directory, 'trace');
    try {
      const result = spawnSync('bash', ['-c', `
set -Eeuo pipefail
PIPELINE=1; CRAWL_ARCHIVE=0; WEB_DISCOVERY=0; FIRST_COLLECTIONS=0; ROTATION_BALANCE=0; STATS_WARM=0
WORKERS_SWAPPED=1; WORKER_ENV_CHANGED=1; HAD_WORKER_LINK=1
systemctl() { echo "$*" >> "$TRACE"; }
install() { echo "$*" >> "$TRACE"; }
restart_background() { [[ $(cat "$CONFIG/acquisition-release.env") == prior-worker ]]; }
mv() { "$NODE_EXEC" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$2" "$3"; }
${recovery}
recover
`], { encoding: 'utf8', env: { ...process.env, OLD: old, OLD_WORKERS: priorWorkers, APP: app, WORKERS: workers,
        STAGE: stage, SWAPPED: webSwapped ? '1' : '0', CONFIG: config, TRACE: trace, NODE_EXEC: process.execPath } });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(realpathSync(app), realpathSync(old));
      assert.equal(realpathSync(workers), realpathSync(priorWorkers));
      assert.equal(readFileSync(path.join(config, 'acquisition-release.env'), 'utf8'), 'prior-worker');
      const commands = readFileSync(trace, 'utf8');
      assert.ok(commands.includes(path.join(priorWorkers, 'scripts/deployment/m70/career-dashboard-pipeline.service')));
      assert.ok(commands.includes(path.join(old, 'scripts/deployment/m70/career-dashboard.service')));
      assert.doesNotMatch(commands, /pg_restore|prisma migrate/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
