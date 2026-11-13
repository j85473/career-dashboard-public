import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, realpathSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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

for (const sameRevision of [false, true]) {
  for (const settings of ['unchanged', 'changed', 'missing baseline']) {
    test(`${sameRevision ? 'same-revision' : 'new-revision'} deployment with ${settings} settings preserves the worker baseline while choosing activation`, () => {
      const directory = realpathSync(mkdtempSync('/tmp/cd-env-selection-'));
      const stage = path.join(directory, 'candidate');
      const workers = sameRevision ? stage : path.join(directory, 'workers');
      const config = path.join(directory, 'config');
      const units = path.join(directory, 'units');
      const selection = path.join(directory, 'selection');
      const scripts = path.join(stage, 'scripts/deployment');
      mkdirSync(path.join(scripts, 'm70'), { recursive: true });
      mkdirSync(workers, { recursive: true });
      mkdirSync(config); mkdirSync(units);
      try {
        for (const root of new Set([stage, workers])) {
          const release = root === stage ? oid : 'b'.repeat(40);
          writeFileSync(path.join(root, '.release-id'), release);
          writeFileSync(path.join(root, '.worker-release.json'), JSON.stringify({ version: 1, release, inputsHash: 'c'.repeat(64) }));
        }
        for (const name of ['worker-release-manifest.mjs', 'worker-environment-fingerprint.mjs']) {
          copyFileSync(path.resolve('scripts/deployment', name), path.join(scripts, name));
        }
        writeFileSync(path.join(config, 'runtime.env'), 'EXAMPLE_SETTING=old\n');
        const baseline = workerEnvironmentFingerprint(config) + '\n';
        const baselineFile = path.join(workers, '.worker-environment.sha256');
        if (settings !== 'missing baseline') writeFileSync(baselineFile, baseline);
        if (settings === 'changed') writeFileSync(path.join(config, 'runtime.env'), 'EXAMPLE_SETTING=new\n');
        for (const root of [path.join(scripts, 'm70'), units]) {
          writeFileSync(path.join(root, 'career-dashboard.service'), 'matching web unit\n');
        }
        writeFileSync(path.join(scripts, 'activate-web-only.sh'), 'activate_web_only() { printf web > "$SELECTION_FILE"; }\n');
        const activation = readFileSync(path.resolve('scripts/deployment/activate-m70.sh'), 'utf8');
        const decision = activation.slice(activation.indexOf('# Only known-compatible UI releases'),
          activation.indexOf('# Capture operator service ownership'))
          .replaceAll('/etc/career-dashboard', config).replaceAll('/etc/systemd/system', units);
        const result = spawnSync('bash', ['-c', `
set -Eeuo pipefail
MODE=normal; BACKUP_REQUIRED=0; FORCE_PREDEPLOY_BACKUP=0; EXISTING_PREDEPLOY_BACKUP=; HAD_WORKER_LINK=1
systemctl() { return 0; }
runuser() { return 0; }
${decision}
printf coordinated > "$SELECTION_FILE"
`], { encoding: 'utf8', env: { ...process.env, STAGE: stage, OLD_WORKERS: workers, SELECTION_FILE: selection } });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.equal(readFileSync(selection, 'utf8'), settings === 'unchanged' ? 'web' : 'coordinated');
        if (settings === 'missing baseline') assert.equal(existsSync(baselineFile), false);
        else assert.equal(readFileSync(baselineFile, 'utf8'), baseline);
        if (!sameRevision) assert.equal(existsSync(path.join(stage, '.worker-environment.sha256')), false);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
}

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
MODE=normal; PIPELINE_NEW=0; CANONICAL_API_NEW=0; PUBLIC_BOARDS_NEW=0; PUBLIC_BOARDS=0; PUBLIC_HTTP_NEW=0
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

for (const failHealth of [false, true]) {
  test(`web activation ${failHealth ? 'rolls back on failed worker proof' : 'succeeds'} without touching background service ownership`, () => {
    const directory = mkdtempSync('/tmp/cd-web-activation-');
    const old = path.join(directory, 'old-web'), stage = path.join(directory, 'new-web');
    const workers = path.join(directory, 'workers-release'), app = path.join(directory, 'app');
    const workerLink = path.join(directory, 'workers');
    for (const name of [old, stage, workers]) mkdirSync(name);
    symlinkSync(old, app); symlinkSync(workers, workerLink);
    const trace = path.join(directory, 'trace');
    const activation = path.resolve('scripts/deployment/activate-web-only.sh');
    try {
      const result = spawnSync('bash', ['-c', `
set -Eeuo pipefail
systemctl() {
  [[ "$2" == career-dashboard.service ]] || { echo "Unexpected background mutation: $*" >&2; return 99; }
  echo "$*" >> "$TRACE"
}
curl() { return 0; }
runuser() { [[ "$FAIL_HEALTH" == 0 ]]; }
python3() { echo cleanup >> "$TRACE"; }
# macOS lacks GNU mv -T; renameSync provides the same atomic symlink replace.
mv() { "$NODE_EXEC" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$2" "$3"; }
source "$ACTIVATION"
activate_web_only
`], { encoding: 'utf8', env: { ...process.env, APP: app, OLD: old, STAGE: stage, WORKERS: workerLink,
        WORKER_REV: oid, REV: 'b'.repeat(40), TRACE: trace, ACTIVATION: activation, NODE_EXEC: process.execPath, FAIL_HEALTH: failHealth ? '1' : '0' } });
      assert.equal(result.status, failHealth ? 1 : 0, result.stderr + result.stdout);
      assert.equal(realpathSync(app), realpathSync(failHealth ? old : stage));
      assert.equal(realpathSync(workerLink), realpathSync(workers));
      assert.equal(existsSync(path.join(stage, '.m70-activation-complete')), !failHealth);
      const commands = readFileSync(trace, 'utf8');
      assert.doesNotMatch(commands, /acquisition|pipeline|scheduler|watchdog|migrate|backup/);
      assert.match(commands, /stop career-dashboard.service\nstart career-dashboard.service/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
