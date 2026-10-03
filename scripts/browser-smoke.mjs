import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { artifactPath, browserLaunchOptions } from './browser-environment.mjs';
import { selectMemoryView } from './browser-view-helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const url = process.env.SPC_PREVIEW_URL || 'http://127.0.0.1:4173/';

const image = new Uint8Array(0x10180);
image.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'), 0);
image.set([0x1a, 0x1a, 0x1a, 0x1e], 0x21);
image[0x25] = 0;
image[0x26] = 2;
image[0x100 + 0xf1] = 0;
image[0x100 + 0x200] = 0x2f;
image[0x100 + 0x201] = 0xfe;
const upload = { name: 'offline-smoke.spc', mimeType: 'application/octet-stream', buffer: Buffer.from(image) };
const titledUpload = (name, title) => {
  const copy = image.slice();
  copy.set(new TextEncoder().encode(title), 0x2e);
  return { name, mimeType: 'application/octet-stream', buffer: Buffer.from(copy) };
};
const slowA = titledUpload('slow-a.spc', 'Older slow track');
const fastB = titledUpload('fast-b.spc', 'Newest fast track');

const browser = await chromium.launch(browserLaunchOptions);
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
let page = await context.newPage();
await page.addInitScript(() => {
  const original = File.prototype.arrayBuffer;
  File.prototype.arrayBuffer = function arrayBuffer() {
    if (this.name === 'slow-a.spc') {
      return new Promise((resolve, reject) => setTimeout(() => original.call(this).then(resolve, reject), 500));
    }
    return original.call(this);
  };
});
const failures = [];
const watch = (target) => {
  target.on('pageerror', (error) => failures.push(error.message));
  target.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
};
watch(page);

await page.goto(url, { waitUntil: 'networkidle' });
assert.equal((await context.request.get(new URL('missing.js', url).href)).status(), 404);
assert.equal((await context.request.get(new URL('%E0%A4%A', url).href)).status(), 400);
await page.getByRole('button', { name: 'Settings' }).click();
await page.getByText('Available offline', { exact: true }).waitFor({ timeout: 20_000 });
await page.getByRole('button', { name: 'ARAM' }).click();
await page.locator('input[accept=".spc"]').setInputFiles(upload);
await page.locator('.track-list button').first().click();
await page.locator('.now-playing .eyebrow').filter({ hasText: 'Playing' }).waitFor({ timeout: 15_000 });
await page.locator('.transport time').filter({ hasText: '00:01' }).waitFor({ timeout: 10_000 });
await page.locator('input[accept=".spc"]').setInputFiles([slowA, fastB]);
const choices = page.locator('.track-list button');
await choices.filter({ hasText: 'slow-a' }).click();
await choices.filter({ hasText: 'fast-b' }).click();
await page.locator('.now-playing strong').filter({ hasText: 'Newest fast track' }).waitFor({ timeout: 10_000 });
await page.waitForTimeout(700);
assert.equal(await page.locator('.now-playing strong').textContent(), 'Newest fast track');

const canvas = page.locator('.map-stage canvas');
assert.equal(await canvas.getAttribute('width'), '256');
await selectMemoryView(page, 'bits');
assert.equal(await canvas.getAttribute('width'), '1024');
const changing = image.slice();
changing.set(new TextEncoder().encode('Changing memory'), 0x2e);
changing.set([0xAC, 0x34, 0x12, 0x2F, 0xFB], 0x100 + 0x200);
for (let i = 0; i < 256; i++) changing[0x100 + 0x8000 + i] = i;
await page.locator('input[accept=".spc"]').setInputFiles({ name: 'changing-memory.spc', mimeType: 'application/octet-stream', buffer: Buffer.from(changing) });
await page.locator('.track-list button').first().click();
await page.locator('.now-playing strong').filter({ hasText: 'Changing memory' }).waitFor();
await selectMemoryView(page, 'bytes');
const bytePixels = new Set();
for (let i = 0; i < 20; i++) {
  bytePixels.add(await canvas.evaluate(c => [...c.getContext('2d').getImageData(0x34, 0x12, 1, 1).data].join(',')));
  await page.waitForTimeout(30);
}
assert(bytePixels.size > 1, 'Actual ARAM byte pixels must change with the running INC fixture');
await selectMemoryView(page, 'bits');
const bitPixels = new Set();
for (let i = 0; i < 12; i++) { bitPixels.add(await canvas.evaluate(c => [...c.getContext('2d').getImageData(0x34 * 4, 0x12 * 2, 4, 2).data].join(','))); await page.waitForTimeout(30); }
assert(bitPixels.size > 1, 'Actual bit pixels must change with the running INC fixture');
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page.locator('.setting-row select').selectOption('grayscale');
await page.getByRole('button', { name: 'ARAM', exact: true }).click();
await selectMemoryView(page, 'xor');
let sawChange = false;
for (let i = 0; i < 12; i++) {
  const reading = await canvas.evaluate(c => {
    let fiber = c[Object.keys(c).find(k => k.startsWith('__reactFiber$'))];
    let history;
    for (; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
      const value = Array.isArray(hook.memoizedState) ? hook.memoizedState[0] : hook.memoizedState;
      if (value?.accept && typeof value.payloadBytes === 'number') history = value;
    }
    const record = history.latest(), previous = history.previous(record);
    const mask = record.payload[0x1234] ^ previous.payload[0x1234];
    return { mask, pixels: [...c.getContext('2d').getImageData(0x34, 0x12, 1, 1).data] };
  });
  const expected = reading.mask;
  assert.deepEqual(reading.pixels, [expected, expected, expected, 255]);
  sawChange ||= reading.mask > 0; await page.waitForTimeout(30);
}
assert(sawChange, 'XOR pixels must match real retained byte changes');
await selectMemoryView(page, 'entropy');
assert.deepEqual(await canvas.evaluate(c => [...c.getContext('2d').getImageData(0, 0x80, 1, 1).data]), [255, 255, 255, 255]);
assert.deepEqual(await canvas.evaluate(c => [...c.getContext('2d').getImageData(0, 0x90, 1, 1).data]), [0, 0, 0, 255]);
await selectMemoryView(page, 'bits');
await page.getByRole('button', { name: '1:1', exact: true }).click();
const mapViewport = await canvas.getAttribute('style');
await page.getByRole('button', { name: 'Waterfall', exact: true }).click();
const waterfall = page.locator('.waterfall-plot canvas');
assert.equal(await waterfall.getAttribute('data-span'), '65536');
await page.getByRole('button', { name: '1:1', exact: true }).click();
assert.equal(await waterfall.getAttribute('data-span'), await waterfall.getAttribute('data-columns'));
const waterfallSpan = await waterfall.getAttribute('data-span');
await page.getByRole('button', { name: 'Map', exact: true }).click();
assert.equal(await canvas.getAttribute('style'), mapViewport);
await page.getByRole('button', { name: 'Waterfall', exact: true }).click();
assert.equal(await waterfall.getAttribute('data-span'), waterfallSpan);
await page.getByRole('button', { name: 'Fit', exact: true }).click();
for (const mode of ['activity', 'activity-bits', 'bytes', 'bits', 'xor', 'xor-bits', 'entropy', 'entropy-bits']) { await selectMemoryView(page, mode); await page.waitForTimeout(150); }
const plotBounds = await page.getByLabel('Zoomable ARAM waterfall').boundingBox();
await page.mouse.move(plotBounds.x + plotBounds.width / 2, plotBounds.y + plotBounds.height / 2);
assert.match(await page.locator('.waterfall-inspector').textContent(), /\$/);
await page.screenshot({ path: artifactPath('waterfall-desktop.png') });
await page.setViewportSize({ width: 390, height: 844 });
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
await page.screenshot({ path: artifactPath('waterfall-phone.png') });
await page.getByRole('button', { name: 'Pause', exact: true }).click();
await page.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 5_000 });

await page.close();
await context.setOffline(true);
page = await context.newPage();
watch(page);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.locator('input[accept=".spc"]').setInputFiles(upload);
await page.locator('.track-list button').first().click();
await page.locator('.now-playing .eyebrow').filter({ hasText: 'Playing' }).waitFor({ timeout: 15_000 });
await page.locator('.transport time').filter({ hasText: '00:01' }).waitFor({ timeout: 10_000 });

const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
let freshPage = await fresh.newPage();
watch(freshPage);
await freshPage.goto(url, { waitUntil: 'networkidle' });
await freshPage.getByRole('button', { name: 'Settings' }).click();
await freshPage.getByText('Available offline', { exact: true }).waitFor({ timeout: 20_000 });
await freshPage.close();
await fresh.setOffline(true);
freshPage = await fresh.newPage();
watch(freshPage);
await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
await freshPage.locator('input[accept=".spc"]').setInputFiles(upload);
await freshPage.locator('.track-list button').first().click();
await freshPage.locator('.now-playing .eyebrow').filter({ hasText: 'Playing' }).waitFor({ timeout: 15_000 });
await freshPage.locator('.transport time').filter({ hasText: '00:01' }).waitFor({ timeout: 10_000 });
await fresh.close();

assert.deepEqual(failures, []);
await browser.close();
console.log('Browser smoke verified: changing raw-memory pixels, Map/Waterfall controls, inspection, pause, responsive layout, and offline playback');
