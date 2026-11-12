import { strict as assert } from 'node:assert';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../scripts/browser-environment.mjs';

const server = await createServer({ configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
let browser;
try {
  browser = await chromium.launch(browserLaunchOptions);
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  for (const failure of ['shader', 'link']) {
    const result = await page.evaluate(async failure => {
      const { fallbackPixels } = await import('/tests/aram-fallback-harness.tsx');
      return fallbackPixels(failure);
    }, failure);
    assert.deepEqual(result.map, { fresh: true, pixel: [255, 255, 255, 255] }, `${failure}: Map must render on a fresh Canvas`);
    assert.deepEqual(result.waterfall, { fresh: true, pixel: [200, 200, 200, 255] }, `${failure}: Waterfall must render on a fresh Canvas`);
    assert.deepEqual(result.visibleWaterfall, { fresh: true, pixel: [200, 200, 200, 255] }, `${failure}: visible Waterfall must remount a fresh Canvas`);
    console.log(JSON.stringify(result));
  }
} finally { await browser?.close(); await server.close(); }
