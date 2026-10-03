import { createHash } from 'node:crypto';
import { copyFile, cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { concatenateWasmSources, copyWasmSources } from './wasm-source-bundle.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const buildPrecacheManifest = (files) => {
  const assets = files
    .map(({ url, bytes }) => ({ url, sha256: hash(bytes) }))
    .sort((left, right) => left.url.localeCompare(right.url));
  const revision = hash(Buffer.from(assets.map((asset) => asset.url + '\0' + asset.sha256).join('\n'))).slice(0, 16);
  return { revision, assets, urls: assets.map((asset) => asset.url) };
};

// A stable cache namespace lets updates replace older application assets.
export const renderServiceWorker = (release) => `const CACHE_PREFIX = 'spc-memory-scope-';
const CACHE = 'spc-memory-scope-${release.revision}';
const ASSETS = ${JSON.stringify(release.assets)};
const assetUrls = new Map(ASSETS.map((asset) => [new URL(asset.url, self.registration.scope).href, asset]));

const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
  .map((value) => value.toString(16).padStart(2, '0')).join('');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (asset) => {
      try {
      const url = new URL(asset.url, self.registration.scope);
      const response = await fetch(url, { cache: 'reload', credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) throw new Error('Precache failed for ' + asset.url);
      const bytes = await response.clone().arrayBuffer();
      if (await digest(bytes) !== asset.sha256) throw new Error('Precache integrity failed for ' + asset.url);
      if (asset.url !== './' && !/\\.html?$/.test(url.pathname) && (response.headers.get('content-type') || '').includes('text/html')) {
        throw new Error('Unexpected HTML for ' + asset.url);
      }
      await cache.put(url, response);
      } catch (error) {
        await cache.put(new URL('./__precache_error__', self.registration.scope), new Response(asset.url + ': ' + (error?.stack || error)));
        throw error;
      }
    }));
    await cache.delete(new URL('./__precache_error__', self.registration.scope));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.postMessage({ type: 'offline-ready', revision: '${release.revision}' }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'offline-status') {
    event.source?.postMessage({ type: 'offline-ready', revision: '${release.revision}' });
  } else if (event.data?.type === 'activate-update') {
    void self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const asset = assetUrls.get(url.href) || (event.request.mode === 'navigate' ? assetUrls.get(new URL('./', self.registration.scope).href) : null);
  if (!asset) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(new URL(asset.url, self.registration.scope));
    if (!cached) throw new Error('Required offline asset is missing: ' + asset.url);
    return cached;
  }));
});
`;

const collectFiles = async (root, directory = root) => {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await collectFiles(root, full));
    else if (entry.name !== 'service-worker.js') {
      const path = relative(root, full).split(sep).join('/');
      results.push({ url: path === 'index.html' ? './' : './' + path, bytes: await readFile(full) });
    }
  }
  return results;
};

export const generateOfflineBuild = async (dist = join(projectRoot, 'dist')) => {
  await copyFile(join(projectRoot, 'LICENSE'), join(dist, 'LICENSE.txt'));
  await copyFile(join(projectRoot, 'NOTICE.md'), join(dist, 'NOTICE.txt'));
  await cp(join(projectRoot, 'LICENSES'), join(dist, 'LICENSES'), { recursive: true, force: true });
  await copyWasmSources(join(dist, 'source'));
  await writeFile(join(dist, 'spc-core-source.txt'), await concatenateWasmSources(join(dist, 'source')));
  const release = buildPrecacheManifest(await collectFiles(dist));
  await writeFile(join(dist, 'service-worker.js'), renderServiceWorker(release));
  return release;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = await generateOfflineBuild();
  console.log('Generated offline release ' + release.revision + ' with ' + release.assets.length + ' assets.');
}
