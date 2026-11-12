import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SOURCE_REPOSITORY = 'j85473/career-dashboard';
export const PUBLIC_REPOSITORY = 'j85473/career-dashboard-public';
const PRIVATE_PATHS = new Set([
  'docs/Candidate_Evidence_Inventory_-_Core_v1.md',
  '.agents/minified_evidence.json',
  '.agents/agents/standard-job-evaluator-v6/agent.md',
]);
const CODE_PATH = /^(?:src|scripts|tests|prisma|vendor|public)\/.*\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|sql|css|scss|svg|prisma|toml)$/i;
const FIXTURE_TITLE = 'Core Evidence parses from the authoritative Markdown with stable hashes';
const PRIVATE_FIXTURE = /^test\('Core Evidence parses from the authoritative Markdown with stable hashes', \(\) => \{[\s\S]*?^\}\);\r?\n/gm;

function git(directory, args, options = {}) {
  return execFileSync('git', ['-C', directory, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

function safePath(name) {
  if (!name || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || path.posix.isAbsolute(name)
    || name.split('/').some((part) => !part || part === '..' || part === '.' || part.toLowerCase() === '.git')) {
    throw new Error('Unsafe path in source snapshot');
  }
  return name;
}

export function isPrivatePath(name) {
  const lower = name.toLowerCase();
  return PRIVATE_PATHS.has(name)
    || /(?:candidate[ _-]*evidence[ _-]*inventory|minified[ _-]*evidence)/i.test(path.posix.basename(name))
    || /^(?:\.agents\/|\.tasks\/|data\/runtime\/|data\/scoring\/results\/|docs\/interview-prep\/)/i.test(lower)
    || /(?:^|\/)\.env(?!\.example$)/i.test(name);
}

function isBinary(data) {
  if (data.includes(0)) return true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); return false; }
  catch { return true; }
}

export function assertNoEvidence(name, data, blobId, forbiddenBlobIds = new Set()) {
  if (forbiddenBlobIds.has(blobId)) throw new Error(`Private evidence fingerprint rejected: ${name}`);
  if (isBinary(data)) return;
  const text = data.toString('utf8');
  if (/^\s*#{1,3}\s+Candidate[ _-]+Evidence[ _-]+Inventory\b/im.test(text)
    || /^## Sheet: Core Evidence\s*$/m.test(text)
    || /^\|[^|\n]*\|\s*(?:DSI|ROC|BAR|TGT|TMO)-\d{3}\s*\|/m.test(text)) {
    throw new Error(`Private evidence structure rejected: ${name}`);
  }
  const evidenceIds = new Set(text.match(/\b(?:DSI|ROC|BAR|TGT|TMO)-\d{3}\b/g) || []);
  if (evidenceIds.size >= 20
    || (evidenceIds.size >= 6 && /"evidence_id"\s*:/.test(text))) {
    throw new Error(`Embedded evidence inventory rejected: ${name}`);
  }
}

function readBlobs(directory, objectIds) {
  const ids = [...new Set(objectIds)];
  const output = git(directory, ['cat-file', '--batch'], { input: `${ids.join('\n')}\n` });
  const result = new Map();
  let offset = 0;
  for (const id of ids) {
    const end = output.indexOf(10, offset);
    if (end < 0) throw new Error('Incomplete Git object response');
    const [actualId, kind, sizeText] = output.subarray(offset, end).toString('ascii').split(' ');
    const size = Number(sizeText);
    if (actualId !== id || kind !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Unexpected Git object in source snapshot');
    }
    offset = end + 1;
    if (offset + size >= output.length || output[offset + size] !== 10) throw new Error('Truncated Git blob');
    result.set(id, output.subarray(offset, offset + size));
    offset += size + 1;
  }
  return result;
}

function treeEntries(directory, ref) {
  return git(directory, ['ls-tree', '-rz', ref]).toString('utf8').split('\0').filter(Boolean).map((row) => {
    const tab = row.indexOf('\t');
    const [mode, kind, id] = row.slice(0, tab).split(' ');
    const name = safePath(row.slice(tab + 1));
    if (kind !== 'blob' || !['100644', '100755'].includes(mode)) {
      throw new Error(`Symlink or submodule requires explicit public review: ${name}`);
    }
    return { name, mode, id };
  });
}

export function sanitizeFoundationTest(source, replacement) {
  const matches = [...source.matchAll(PRIVATE_FIXTURE)];
  if (matches.length !== 1 || !source.includes(FIXTURE_TITLE)) {
    throw new Error('The private evidence integration test changed; review its public replacement before publishing');
  }
  let sanitized = source.replace(PRIVATE_FIXTURE, `${replacement.trim()}\n`);
  if (!/\bfs\./.test(sanitized)) sanitized = sanitized.replace(/^import fs from 'node:fs';\r?\n/m, '');
  return sanitized;
}

function sanitizeIgnore(source) {
  return source.replace(/# \.agents\/minified_evidence\.json is intentionally tracked[\s\S]*?!\.agents\/minified_evidence\.json\r?\n/, '')
    .replace(/^!\.agents\/minified_evidence\.json\r?\n/gm, '')
    + '\n# Private evidence is excluded from the public source and history.\n'
    + [...PRIVATE_PATHS].map((name) => `/${name}\n`).join('');
}

function validatePolicy(policy) {
  if (policy.schemaVersion !== 'public-copy-policy-v1'
    || policy.sourceRepository !== SOURCE_REPOSITORY || policy.targetRepository !== PUBLIC_REPOSITORY
    || !/^[a-f0-9]{40}$/.test(policy.trustedPublicBase)
    || !Array.isArray(policy.approvedPaths) || !Array.isArray(policy.forbiddenEvidenceBlobIds)
    || !policy.approvedBinarySha256) throw new Error('Invalid public-copy policy');
}

export function createPublicSnapshot(entries, blobs, policy) {
  validatePolicy(policy);
  const approved = new Set(policy.approvedPaths);
  const forbidden = new Set(policy.forbiddenEvidenceBlobIds);
  for (const entry of entries) {
    if (PRIVATE_PATHS.has(entry.name)
      || /(?:candidate[ _-]*evidence[ _-]*inventory|minified[ _-]*evidence)/i.test(path.posix.basename(entry.name))) {
      forbidden.add(entry.id);
    }
  }
  const output = new Map();
  const skipped = [];
  const sourceByName = new Map(entries.map((entry) => [entry.name, entry]));
  const sourceText = (name) => {
    const entry = sourceByName.get(name);
    if (!entry || !blobs.has(entry.id)) throw new Error(`Required public template is missing: ${name}`);
    return blobs.get(entry.id).toString('utf8');
  };
  for (const entry of entries) {
    const { name, id, mode } = entry;
    safePath(name);
    if (isPrivatePath(name) || name.startsWith('.github/workflows/')) continue;
    const allowed = approved.has(name) || CODE_PATH.test(name)
      || name.startsWith('scripts/public-copy/templates/');
    if (!allowed) { skipped.push(name); continue; }
    let data = blobs.get(id);
    if (!data) throw new Error(`Missing source blob: ${name}`);
    if (name === 'src/lib/__tests__/scoringFoundation.test.ts') {
      data = Buffer.from(sanitizeFoundationTest(data.toString('utf8'), sourceText('scripts/public-copy/templates/evidence-parser-test.txt')));
    } else if (name === '.gitignore') {
      data = Buffer.from(sanitizeIgnore(data.toString('utf8')));
    } else if (name === 'README.md') {
      let readme = data.toString('utf8').replace('# Career Dashboard\n', '# Career Dashboard\n\nPublic source copy. Private candidate evidence and private Git history are excluded. See [private evidence setup](docs/PRIVATE_EVIDENCE.md). Production remains in the private operational repository.\n');
      readme = readme.replaceAll('(docs/Candidate_Evidence_Inventory_-_Core_v1.md)', '(docs/PRIVATE_EVIDENCE.md)');
      data = Buffer.from(readme);
    }
    assertNoEvidence(name, data, id, forbidden);
    if (isBinary(data) && createHash('sha256').update(data).digest('hex') !== policy.approvedBinarySha256[name]) {
      throw new Error(`New or changed binary requires explicit public review: ${name}`);
    }
    output.set(name, { data, mode });
  }
  output.set('docs/PRIVATE_EVIDENCE.md', { data: Buffer.from(sourceText('scripts/public-copy/templates/private-evidence.md')), mode: '100644' });
  output.set('.github/workflows/public-validation.yml', { data: Buffer.from(sourceText('scripts/public-copy/templates/public-validation.yml')), mode: '100644' });
  for (const [name, file] of output) assertNoEvidence(name, file.data, '', forbidden);
  return { files: output, skipped, forbidden };
}

export function auditPublicHistory(directory, policy, forbidden) {
  git(directory, ['merge-base', '--is-ancestor', policy.trustedPublicBase, 'HEAD']);
  const rows = git(directory, ['rev-list', '--objects', 'HEAD']).toString('utf8').trim().split('\n');
  const metadata = git(directory, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: `${rows.map((row) => row.split(' ', 1)[0]).join('\n')}\n`,
  }).toString('utf8').trim().split('\n');
  const objects = [];
  for (let index = 0; index < rows.length; index += 1) {
    const space = rows[index].indexOf(' ');
    const name = space < 0 ? '' : rows[index].slice(space + 1);
    const [id, kind] = metadata[index].split(' ');
    if (kind !== 'blob') continue;
    if (PRIVATE_PATHS.has(name)) throw new Error('Public history contains an excluded evidence path');
    objects.push({ name, id });
  }
  const blobs = readBlobs(directory, objects.map(({ id }) => id));
  for (const { name, id } of objects) assertNoEvidence(name, blobs.get(id), id, forbidden);
  return objects.length;
}

export function syncPublicCopy(sourceDirectory, targetDirectory) {
  const source = fs.realpathSync(sourceDirectory);
  const target = fs.realpathSync(targetDirectory);
  if (source === target || source.startsWith(`${target}${path.sep}`) || target.startsWith(`${source}${path.sep}`)) {
    throw new Error('Source and public checkout must be separate directories');
  }
  const policy = JSON.parse(fs.readFileSync(path.join(source, '.github/public-copy-policy.json'), 'utf8'));
  validatePolicy(policy);
  const expectedRemote = `https://github.com/${PUBLIC_REPOSITORY}.git`;
  if (git(target, ['remote', 'get-url', 'origin']).toString('utf8').trim() !== expectedRemote) {
    throw new Error('Refusing to update an unexpected public remote');
  }
  if (git(target, ['symbolic-ref', '--short', 'HEAD']).toString('utf8').trim() !== 'main') throw new Error('Public checkout must be on main');
  if (git(target, ['status', '--porcelain', '--untracked-files=all']).length) throw new Error('Public checkout is not clean');
  const entries = treeEntries(source, 'HEAD');
  const blobs = readBlobs(source, entries.map(({ id }) => id));
  const snapshot = createPublicSnapshot(entries, blobs, policy);
  const historyBlobsChecked = auditPublicHistory(target, policy, snapshot.forbidden);
  const parent = git(target, ['rev-parse', 'HEAD']).toString('ascii').trim();
  for (const entry of treeEntries(target, 'HEAD')) fs.rmSync(path.join(target, entry.name));
  for (const [name, { data, mode }] of snapshot.files) {
    const destination = path.join(target, safePath(name));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data, { mode: mode === '100755' ? 0o755 : 0o644 });
    fs.chmodSync(destination, mode === '100755' ? 0o755 : 0o644);
  }
  git(target, ['add', '-A']);
  const tree = git(target, ['write-tree']).toString('ascii').trim();
  const staged = treeEntries(target, tree);
  const stagedBlobs = readBlobs(target, staged.map(({ id }) => id));
  for (const entry of staged) {
    if (isPrivatePath(entry.name)) throw new Error('Private path reached the staged public tree');
    assertNoEvidence(entry.name, stagedBlobs.get(entry.id), entry.id, snapshot.forbidden);
  }
  const changed = git(target, ['diff', '--cached', '--name-only']).length > 0;
  if (changed) {
    git(target, ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', 'Update sanitized public source snapshot']);
    const parents = git(target, ['rev-list', '--parents', '-n', '1', 'HEAD']).toString('ascii').trim().split(' ');
    if (parents.length !== 2 || parents[1] !== parent) throw new Error('Public commit has an unexpected parent');
  }
  return { changed, publishedFiles: staged.length, historyBlobsChecked, skippedUnreviewedFiles: snapshot.skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/public-copy/sync.mjs SOURCE_REPO PUBLIC_CHECKOUT');
    const summary = syncPublicCopy(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `## Public source copy\n\n${summary.changed ? 'Prepared a sanitized public update.' : 'The public copy is already current.'}\n\nChecked ${summary.historyBlobsChecked} public historical blobs. Published ${summary.publishedFiles} files. Held ${summary.skippedUnreviewedFiles.length} unreviewed files out of the public copy.\n`);
    }
  } catch (error) {
    process.stderr.write(`Public copy publication stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}
