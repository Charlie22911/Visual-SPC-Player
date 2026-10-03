import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(project, 'dist');
const hostIndex = process.argv.indexOf('--host');
const host = hostIndex >= 0 ? process.argv[hostIndex + 1] : '127.0.0.1';
const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4173;

if (!existsSync(join(root, 'index.html'))) {
  throw new Error('dist/index.html is missing. Run pnpm build first.');
}

const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json'],
]);

createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Malformed request URL');
    return;
  }
  const requested = normalize(pathname).replace(/^([/\\])+/, '');
  let file = resolve(root, requested || 'index.html');
  if (!file.startsWith(root + sep) && file !== root) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(requested)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    file = join(root, 'index.html');
  }
  response.writeHead(200, {
    'Content-Type': mime.get(extname(file)) ?? 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
  });
  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Could not read file');
  });
  stream.pipe(response);
}).listen(port, host, () => {
  console.log(`Visual SPC Player: http://${host}:${port}`);
});
