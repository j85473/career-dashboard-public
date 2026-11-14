import { buildSync } from 'esbuild';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WORKER_COMPONENTS, COMPONENT_PROTOCOL, coordinationInput } from './worker-components.mjs';

export function componentManifest(tree, isWebOnly, root = process.cwd()) {
  const records = new Map(tree.split('\0').filter(Boolean).map((entry) => [entry.slice(entry.indexOf('\t') + 1), entry]));
  /** @type {Record<string, {inputsHash: string, files: string[]}>} */
  const components = {};
  const assigned = new Set();
  const hash = (names) => createHash('sha256').update([...names].sort().map((name) => records.get(name)).join('\0')).digest('hex');
  for (const [name, component] of Object.entries(WORKER_COMPONENTS)) {
    const graph = buildSync({ absWorkingDir: root, entryPoints: component.entries, bundle: true, write: false,
      outdir: 'unused-worker-graph', metafile: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
    const files = new Set(component.entries);
    for (const input of Object.keys(graph.metafile.inputs)) {
      const relative = path.relative(root, path.resolve(root, input)).split(path.sep).join('/');
      if (relative.startsWith('node_modules/') || relative.startsWith('src/generated/')) continue;
      if (!records.has(relative)) throw new Error(`Worker dependency is outside the committed tree: ${relative}`);
      files.add(relative);
    }
    for (const filename of records.keys()) {
      if (component.units.some((unit) => filename === `scripts/deployment/m70/${unit}.service`
        || filename === `scripts/deployment/m70/${unit}.timer`)) files.add(filename);
    }
    for (const filename of files) assigned.add(filename);
    components[name] = { inputsHash: hash(files), files: [...files].sort() };
  }
  const common = [...records.keys()].filter((name) => coordinationInput(name) || (!assigned.has(name) && !isWebOnly(name)));
  return { protocol: COMPONENT_PROTOCOL, coordinationHash: hash(common), components };
}
