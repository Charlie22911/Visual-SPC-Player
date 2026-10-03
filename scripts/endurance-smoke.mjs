import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { browserLaunchOptions } from './browser-environment.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const url = process.env.SPC_PREVIEW_URL || 'http://127.0.0.1:4173/';
const durationMs = Number(process.env.SPC_ENDURANCE_MS || 600_000);
const image = new Uint8Array(0x10180);
image.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'));
image.set([0x1a, 0x1a, 0x1a, 0x1e], 0x21);
image[0x25] = 0;
image[0x26] = 2;
image[0x100 + 0xf1] = 0;
image[0x100 + 0x200] = 0x2f;
image[0x100 + 0x201] = 0xfe;

const browser = await chromium.launch(browserLaunchOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const failures = [];
page.on('pageerror', (error) => failures.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
await page.goto(url, { waitUntil: 'networkidle' });
await page.locator('input[accept=".spc"]').setInputFiles({
  name: 'endurance.spc', mimeType: 'application/octet-stream', buffer: Buffer.from(image),
});
await page.locator('.track-list button').first().click();
await page.locator('.now-playing .eyebrow').filter({ hasText: 'Playing' }).waitFor({ timeout: 15_000 });

const started = Date.now();
let firstHeap = 0;
while (Date.now() - started < durationMs) {
  await page.waitForTimeout(Math.min(30_000, durationMs - (Date.now() - started)));
  const sample = await page.evaluate(() => ({
    status: document.querySelector('.now-playing .eyebrow')?.textContent,
    time: document.querySelector('.transport time')?.textContent,
    heap: performance.memory?.usedJSHeapSize ?? 0,
  }));
  if (!firstHeap && sample.heap) firstHeap = sample.heap;
  assert.equal(sample.status, 'Playing');
  assert.deepEqual(failures, []);
  console.log('endurance', Math.round((Date.now() - started) / 1000) + 's', sample.time, sample.heap ? Math.round(sample.heap / 1048576) + ' MiB' : 'heap unavailable');
}
const final = await page.evaluate(() => ({
  time: document.querySelector('.transport time')?.textContent ?? '00:00',
  heap: performance.memory?.usedJSHeapSize ?? 0,
}));
const [minutes, seconds] = final.time.split(':').map(Number);
assert.equal(minutes * 60 + seconds >= Math.floor(durationMs / 1000) - 10, true);
if (firstHeap && final.heap) assert.equal(final.heap - firstHeap < 100 * 1024 * 1024, true);
assert.deepEqual(failures, []);
await browser.close();
console.log('Endurance playback verified for ' + Math.round(durationMs / 1000) + ' seconds');
