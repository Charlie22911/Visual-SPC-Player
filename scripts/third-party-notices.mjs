import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const bundledNotices = async (root = projectRoot) => {
  const licenseFiles = (await readdir(join(root, 'LICENSES'), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const files = ['NOTICE.md', 'LICENSE', ...licenseFiles.map((name) => 'LICENSES/' + name)];
  const parts = [];
  for (const file of files) {
    parts.push(`===== ${file} =====\n\n${(await readFile(join(root, file), 'utf8')).trimEnd()}\n`);
  }
  return parts.join('\n');
};
