import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { serviceWorkerTemplate } from './pwa-worker';

export interface BuildMetadata {
  version: string;
  buildId: string;
}

export function financePwa(version: string): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'finance-production-pwa',
    apply: 'build',
    configResolved(resolved) { config = resolved; },
    async closeBundle() {
      await writePwaArtifacts(resolve(config.root, config.build.outDir), version);
    },
  };
}

async function outputFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await outputFiles(join(directory, entry.name), name + '/'));
    else if (name !== 'sw.js' && name !== 'version.json') files.push(name);
  }
  return files.sort();
}

export async function writePwaArtifacts(directory: string, version: string): Promise<BuildMetadata> {
  const hash = createHash('sha256').update(JSON.stringify(version)).update(serviceWorkerTemplate);
  for (const name of await outputFiles(directory)) {
    const bytes = await readFile(join(directory, name));
    hash.update(JSON.stringify([name, bytes.length])).update(bytes);
  }
  const metadata = { version, buildId: hash.digest('hex') };
  await writeFile(join(directory, 'version.json'), JSON.stringify(metadata) + '\n');
  await writeFile(join(directory, 'sw.js'), serviceWorkerTemplate.replaceAll('__FINANCE_BUILD_ID__', metadata.buildId));
  return metadata;
}
