import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertNoEvidence, createPublicSnapshot, isPrivatePath, sanitizeFoundationTest, syncPublicCopy,
} from '../../scripts/public-copy/sync.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const template = (name) => fs.readFileSync(path.join(project, 'scripts/public-copy/templates', name));
const privateFixture = "import fs from 'node:fs';\n\ntest('Core Evidence parses from the authoritative Markdown with stable hashes', () => {\n  const secret = 'fictional private-only assertion';\n});\n\ntest('unrelated coverage', () => {});\n";
const policy = (extra = {}) => ({
  schemaVersion: 'public-copy-policy-v1',
  sourceRepository: 'j85473/career-dashboard', targetRepository: 'j85473/career-dashboard-public',
  trustedPublicBase: 'a'.repeat(40), approvedPaths: ['README.md', '.gitignore', '.github/public-copy-policy.json'],
  approvedBinarySha256: {}, forbiddenEvidenceBlobIds: [], ...extra,
});
function candidateFiles(extra = {}) {
  return {
    'README.md': Buffer.from('# Career Dashboard\n'),
    '.gitignore': Buffer.from('.env\n'),
    'scripts/public-copy/templates/private-evidence.md': template('private-evidence.md'),
    'scripts/public-copy/templates/public-validation.yml': template('public-validation.yml'),
    'scripts/public-copy/templates/evidence-parser-test.txt': template('evidence-parser-test.txt'),
    ...extra,
  };
}
function snapshot(files, rules = policy()) {
  const entries = []; const blobs = new Map();
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const id = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    entries.push({ name, id, mode: '100644' }); blobs.set(id, data);
  }
  return createPublicSnapshot(entries, blobs, rules);
}

test('EI paths, condensed copies, runtime exports and renamed inventory filenames stay private', () => {
  for (const name of ['docs/Candidate_Evidence_Inventory_-_Core_v1.md', '.agents/minified_evidence.json', 'src/Candidate Evidence Inventory.xlsx', 'data/runtime/state.json', 'docs/interview-prep/private.md', '.env.production']) {
    assert.equal(isPrivatePath(name), true, name);
  }
  assert.equal(isPrivatePath('.env.example'), false);
  assert.equal(isPrivatePath('src/lib/scoringEvidence.ts'), false);
});

test('known renamed evidence blobs and embedded inventories stop publication', () => {
  assert.throws(() => assertNoEvidence('src/renamed.ts', Buffer.from('copied content'), 'abc', new Set(['abc'])), /fingerprint/);
  const bulk = Array.from({ length: 21 }, (_, index) => `DSI-${String(index + 1).padStart(3, '0')}`).join(' ');
  assert.throws(() => assertNoEvidence('src/renamed.ts', Buffer.from(bulk), ''), /Embedded evidence/);
  assert.throws(() => assertNoEvidence('docs/notes.md', Buffer.from('| High | DSI-001 | Fictional private row |'), ''), /structure/);
  assert.throws(() => assertNoEvidence('docs/notes.md', Buffer.from('# Candidate Evidence Inventory\nFictional test content.'), ''), /structure/);
});

test('source workflows never cross over and public validation comes from its reviewed template', () => {
  const result = snapshot(candidateFiles({ '.github/workflows/deploy.yml': 'run: deploy-to-production', '.agents/hooks.json': '{}\n' }));
  assert.equal(result.files.has('.github/workflows/deploy.yml'), false);
  assert.equal(result.files.has('.agents/hooks.json'), false);
  assert.equal(result.files.get('.github/workflows/public-validation.yml').data.toString(), template('public-validation.yml').toString());
});

test('public snapshot excludes private files and holds unreviewed documents and data', () => {
  const result = snapshot(candidateFiles({
    'docs/Candidate_Evidence_Inventory_-_Core_v1.md': '# Candidate Evidence Inventory\nPrivate fictional example.',
    '.agents/minified_evidence.json': 'fictional private condensed record',
    'docs/new-interview-notes.md': 'unreviewed document', 'data/new-export.json': '{}',
    'src/lib/new-code.ts': 'export const value = 1;',
  }));
  assert.equal(result.files.has('docs/Candidate_Evidence_Inventory_-_Core_v1.md'), false);
  assert.equal(result.files.has('.agents/minified_evidence.json'), false);
  assert.deepEqual(result.skipped.sort(), ['data/new-export.json', 'docs/new-interview-notes.md']);
  assert.equal(result.files.has('src/lib/new-code.ts'), true);
});

test('private evidence copied to an otherwise allowed code path is rejected by its current blob fingerprint', () => {
  const data = 'fictional confidential content without structural markers';
  assert.throws(() => snapshot(candidateFiles({
    'docs/Candidate_Evidence_Inventory_-_Core_v1.md': data, 'src/lib/renamed.ts': data,
  })), /fingerprint/);
});

test('new or modified binary files require an exact reviewed hash', () => {
  const data = Buffer.from([0, 1, 2, 255]);
  const files = candidateFiles({ 'public/image.png': data });
  assert.throws(() => snapshot(files, policy({ approvedPaths: ['public/image.png'] })), /binary requires/);
  const approvedBinarySha256 = { 'public/image.png': createHash('sha256').update(data).digest('hex') };
  assert.equal(snapshot(files, policy({ approvedPaths: ['public/image.png'], approvedBinarySha256 })).files.has('public/image.png'), true);
  assert.throws(() => snapshot(candidateFiles({ 'public/image.png': Buffer.from([0, 3]) }), policy({ approvedPaths: ['public/image.png'], approvedBinarySha256 })), /binary requires/);
});

test('private integration assertions are replaced without discarding unrelated tests', () => {
  const output = sanitizeFoundationTest(privateFixture, template('evidence-parser-test.txt').toString());
  assert.doesNotMatch(output, /private-only assertion|import fs/);
  assert.match(output, /unrelated coverage/);
  assert.match(output, /Fictional parser fixture only/);
  assert.throws(() => sanitizeFoundationTest(privateFixture.replace('stable hashes', 'changed format'), 'replacement'), /changed/);
});

test('unsafe paths and mismatched publication targets fail closed', () => {
  assert.throws(() => snapshot(candidateFiles({ '../escape.ts': 'unsafe' })), /Unsafe path/);
  assert.throws(() => snapshot(candidateFiles(), policy({ targetRepository: 'someone/else' })), /Invalid public-copy policy/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-copy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const target = path.join(root, 'target');
  const run = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  for (const directory of [source, target]) {
    fs.mkdirSync(directory); run(directory, 'init', '-b', 'main');
    run(directory, 'config', 'user.name', 'Fictional Test'); run(directory, 'config', 'user.email', 'test@example.invalid');
  }
  fs.writeFileSync(path.join(target, 'README.md'), 'Reviewed public base.\n');
  run(target, 'add', '.'); run(target, 'commit', '-m', 'Public base');
  const trustedPublicBase = run(target, 'rev-parse', 'HEAD');
  run(target, 'remote', 'add', 'origin', 'https://github.com/j85473/career-dashboard-public.git');
  const files = candidateFiles({
    'src/lib/__tests__/scoringFoundation.test.ts': privateFixture,
    'docs/Candidate_Evidence_Inventory_-_Core_v1.md': '# Candidate Evidence Inventory\nFictional private fixture.',
    'src/new.ts': 'export const value = 1;\n',
    '.github/public-copy-policy.json': JSON.stringify(policy({ trustedPublicBase })),
  });
  for (const [name, data] of Object.entries(files)) {
    const destination = path.join(source, name); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, data);
  }
  run(source, 'add', '.'); run(source, 'commit', '-m', 'Private source history with fictional evidence');
  return { root, source, target, run, trustedPublicBase };
}

test('publication appends one public parent, imports no private objects, and is idempotent', (t) => {
  const f = fixture(t); const privateTip = f.run(f.source, 'rev-parse', 'HEAD');
  const first = syncPublicCopy(f.source, f.target);
  assert.equal(first.changed, true);
  assert.deepEqual(f.run(f.target, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1), [f.trustedPublicBase]);
  assert.throws(() => f.run(f.target, 'cat-file', '-e', privateTip));
  assert.equal(fs.existsSync(path.join(f.target, 'docs/Candidate_Evidence_Inventory_-_Core_v1.md')), false);
  assert.match(f.run(f.target, 'check-ignore', '--no-index', 'docs/Candidate_Evidence_Inventory_-_Core_v1.md'), /Candidate_Evidence/);
  assert.equal(syncPublicCopy(f.source, f.target).changed, false);
});

test('a renamed private blob stops the update before the public checkout changes', (t) => {
  const f = fixture(t); const before = f.run(f.target, 'rev-parse', 'HEAD');
  fs.copyFileSync(path.join(f.source, 'docs/Candidate_Evidence_Inventory_-_Core_v1.md'), path.join(f.source, 'src/renamed.ts'));
  f.run(f.source, 'add', '.'); f.run(f.source, 'commit', '-m', 'Fictional attempted leak');
  assert.throws(() => syncPublicCopy(f.source, f.target), /fingerprint|structure/);
  assert.equal(f.run(f.target, 'rev-parse', 'HEAD'), before);
  assert.equal(f.run(f.target, 'status', '--porcelain'), '');
});

test('evidence in a deleted historical public file still blocks publication', (t) => {
  const f = fixture(t);
  const destination = path.join(f.target, 'docs/Candidate_Evidence_Inventory_-_Core_v1.md');
  fs.mkdirSync(path.dirname(destination)); fs.writeFileSync(destination, '# Candidate Evidence Inventory\nFictional historical leak.');
  f.run(f.target, 'add', '.'); f.run(f.target, 'commit', '-m', 'Fictional historical leak');
  fs.rmSync(destination); f.run(f.target, 'add', '-A'); f.run(f.target, 'commit', '-m', 'Remove latest file only');
  const before = f.run(f.target, 'rev-parse', 'HEAD');
  assert.throws(() => syncPublicCopy(f.source, f.target), /history contains|evidence/);
  assert.equal(f.run(f.target, 'rev-parse', 'HEAD'), before);
});

test('dirty, nested, and unexpected public targets are refused', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.target, 'uncommitted.txt'), 'work');
  assert.throws(() => syncPublicCopy(f.source, f.target), /not clean/);
  fs.rmSync(path.join(f.target, 'uncommitted.txt'));
  f.run(f.target, 'remote', 'set-url', 'origin', 'https://github.com/wrong/repository.git');
  assert.throws(() => syncPublicCopy(f.source, f.target), /unexpected public remote/);
  assert.throws(() => syncPublicCopy(f.source, f.source), /separate directories/);
});
