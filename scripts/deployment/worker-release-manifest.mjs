import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { componentManifest } from './worker-component-manifest.mjs';

// Fail closed: unknown files affect workers. UI files cannot change the API,
// database, shared libraries, runtime evidence, packages or deployment units.
export function webOnlyPath(name) {
  return name.startsWith('src/components/') || name.startsWith('src/hooks/')
    || name.startsWith('public/')
    || (name.startsWith('src/app/') && !name.startsWith('src/app/api/'))
    || name.startsWith('tests/') || name.includes('/__tests__/')
    || name.startsWith('.github/') || ['AGENTS.md', 'README.md', '.gitignore', 'docs/M70_PRODUCTION_OPERATIONS.md'].includes(name);
}

export function workerInputsHash(tree) {
  return createHash('sha256').update(tree.split('\0').filter(Boolean).filter((entry) => {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error('Invalid committed tree.');
    return !webOnlyPath(entry.slice(tab + 1));
  }).sort().join('\0')).digest('hex');
}

export function readManifest(directory) {
  const manifest = JSON.parse(readFileSync(resolve(directory, '.worker-release.json'), 'utf8'));
  const release = readFileSync(resolve(directory, '.release-id'), 'utf8').trim();
  if (![1, 2].includes(manifest.version) || manifest.release !== release || !/^[a-f0-9]{40}$/.test(release)
    || !/^[a-f0-9]{64}$/.test(manifest.inputsHash)) throw new Error('Unverified worker manifest.');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'create') {
      const release = process.argv[3];
      if (!/^[a-f0-9]{40}$/.test(release)) throw new Error('An exact committed release is required.');
      const tree = execFileSync('git', ['ls-tree', '-rz', '--full-tree', release], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      console.log(JSON.stringify({ version: 2, release, inputsHash: workerInputsHash(tree),
        workerGroups: componentManifest(tree, webOnlyPath) }));
    } else if (process.argv[2] === 'compatible') {
      const candidate = readManifest(process.argv[3]);
      const workers = readManifest(process.argv[4]);
      if (candidate.inputsHash !== workers.inputsHash) throw new Error('Worker inputs changed.');
    } else throw new Error('Expected create or compatible.');
  } catch (error) {
    console.error(`Using coordinated activation: ${error.message}`);
    process.exitCode = 1;
  }
}
