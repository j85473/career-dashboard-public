import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function workerEnvironmentFingerprint(directory) {
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.env') && name !== 'acquisition-release.env').sort()) {
    // Include optional worker environment files as well as runtime.env. Read
    // failure refuses the independent path; secret contents are never logged.
    hash.update(name).update('\0').update(readFileSync(resolve(directory, name))).update('\0');
  }
  return hash.digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(workerEnvironmentFingerprint(process.argv[2]));
  } catch {
    console.error('Could not establish worker environment compatibility.');
    process.exitCode = 1;
  }
}
