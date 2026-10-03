import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
  throw new Error('The release version must be a semantic version without path separators');
}
const html = await readFile(join(project, 'Visual-SPC-Player.html'));
if (!html.includes(Buffer.from('data-spc-standalone="true"'))) {
  throw new Error('Build the standalone HTML before packaging a release');
}
const destination = join(project, 'release', `v${version}`);
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'Visual-SPC-Player.html'), html);
await writeFile(join(destination, 'SHA256SUMS'),
  `${createHash('sha256').update(html).digest('hex')}  Visual-SPC-Player.html\n`);
console.log(`Prepared release/v${version}/Visual-SPC-Player.html and SHA256SUMS`);
