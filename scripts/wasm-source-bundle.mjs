import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const copyWasmSources = async (destination) => {
  const copyDirectory = async (path) => {
    for (const entry of await readdir(join(project, path), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('build')) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await copyDirectory(child);
      else if (entry.isFile()) {
        await mkdir(dirname(join(destination, child)), { recursive: true });
        await copyFile(join(project, child), join(destination, child));
      }
    }
  };
  await copyDirectory('native');
  await copyDirectory('LICENSES');
  for (const path of ['LICENSE', 'NOTICE.md', 'scripts/build-wasm.mjs', 'docs/building.md', 'docs/provenance.md', 'docs/source-provenance.json']) {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await copyFile(join(project, path), join(destination, path));
  }
};

export const concatenateWasmSources = async (sourceRoot) => {
  const parts = [];
  const visit = async (directory) => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const name = relative(sourceRoot, path).replaceAll('\\', '/');
        const contents = await readFile(path, 'utf8');
        parts.push(`===== ${name} =====\n\n${contents.trimEnd()}\n`);
      }
    }
  };
  await visit(sourceRoot);
  return parts.join('\n');
};
