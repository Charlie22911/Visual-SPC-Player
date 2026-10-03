// @vitest-environment node
import { describe, expect, test } from 'vitest';
// @ts-expect-error Build helper is plain ESM so it can run after Vite.
import { buildPrecacheManifest, renderServiceWorker } from '../scripts/offline-build.mjs';

describe('offline release generation', () => {
  test('versions a complete, deterministic execution-asset manifest', () => {
    const bytes = (value: string) => new TextEncoder().encode(value);
    const release = buildPrecacheManifest([
      { url: './index.html', bytes: bytes('shell') },
      { url: './assets/app.js', bytes: bytes('app') },
      { url: './assets/spc.worklet.js', bytes: bytes('worklet') },
      { url: './spc_core.wasm', bytes: bytes('wasm') },
    ]);
    expect(release.urls).toEqual([
      './assets/app.js', './assets/spc.worklet.js', './index.html', './spc_core.wasm',
    ]);
    expect(release.revision).toMatch(/^[a-f0-9]{16}$/);
    const worker = renderServiceWorker(release);
    expect(worker).toContain('spc-memory-scope-' + release.revision);
    expect(worker).toContain('./assets/spc.worklet.js');
    expect(worker).not.toContain('cache.put(event.request');
  });

  test('changes release identity when any execution asset changes and waits for user activation', () => {
    const first = buildPrecacheManifest([{ url: './app.js', bytes: new Uint8Array([1]) }]);
    const second = buildPrecacheManifest([{ url: './app.js', bytes: new Uint8Array([2]) }]);
    expect(first.revision).not.toBe(second.revision);
    const worker = renderServiceWorker(second);
    expect(worker).toContain("type === 'activate-update'");
    expect(worker).not.toContain("addEventListener('install', () => self.skipWaiting");
  });
});
