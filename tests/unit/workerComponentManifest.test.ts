import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { componentManifest } from '../../scripts/deployment/worker-component-manifest.mjs';
import { webOnlyPath } from '../../scripts/deployment/worker-release-manifest.mjs';

test('the actual dependency graph isolates acquisition changes and protects shared or unknown inputs', () => {
  const filenames = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0').filter((name) => name && !name.startsWith('.tasks/') && fs.existsSync(name));
  const records = new Map<string, string>(filenames.map((name) => [name, `100644 blob ${createHash('sha1').update(fs.readFileSync(name)).digest('hex')}\t${name}\0`]));
  const create = (changes: Record<string, string> = {}) => componentManifest([...new Map([...records, ...Object.entries(changes)])
    .values()].join(''), webOnlyPath);
  const before = create();
  const acquisitionFile = 'scripts/workers/ats-remote-continuation.ts';
  assert.ok(before.components.acquisition.files.includes(acquisitionFile));
  assert.ok(!before.components.pipeline.files.includes(acquisitionFile));
  const acquisition = create({ [acquisitionFile]: `100644 blob ${'0'.repeat(40)}\t${acquisitionFile}\0` });
  assert.equal(before.coordinationHash, acquisition.coordinationHash);
  for (const [name, component] of Object.entries(before.components)) {
    assert.equal((component as { inputsHash: string }).inputsHash === acquisition.components[name].inputsHash, name !== 'acquisition', name);
  }
  const unknown = create({ 'unknown-worker-input.txt': `100644 blob ${'0'.repeat(40)}\tunknown-worker-input.txt\0` });
  assert.notEqual(unknown.coordinationHash, before.coordinationHash);
  const schema = 'prisma/schema.prisma';
  assert.notEqual(create({ [schema]: `100644 blob ${'0'.repeat(40)}\t${schema}\0` }).coordinationHash, before.coordinationHash);
});
