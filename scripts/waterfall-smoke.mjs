import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { artifactPath, browserLaunchOptions, browserName } from './browser-environment.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { selectMemoryView } from './browser-view-helpers.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const url = process.env.SPC_PREVIEW_URL || 'http://127.0.0.1:4173/';
const image = new Uint8Array(0x10180);
image.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'));
image.set([0x1a, 0x1a, 0x1a, 0x1e], 0x21);
image[0x26] = 2;
image.set([0xac, 0x34, 0x12, 0x2f, 0xfb], 0x300);
const upload = { name: 'changing-memory.spc', mimeType: 'application/octet-stream', buffer: Buffer.from(image) };
const browser = await chromium.launch(browserLaunchOptions);
const errors = [];
const watch = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
};
const load = async page => {
  await page.locator('input[accept=".spc"]').setInputFiles(upload);
  await page.locator('.track-list button').first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
};
// Read diagnostics from existing React state, without a production debug API.
// The scan identifies values by their contracts rather than bundled names.
const sample = page => page.evaluate(() => {
  const element = document.querySelector('.waterfall-plot') ?? document.querySelector('.aram-panel');
  let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
  let stream, history, renderer, stats;
  for (; fiber; fiber = fiber.return) {
    for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
      const value = Array.isArray(hook.memoizedState) ? hook.memoizedState[0] : hook.memoizedState;
      if (value?.publish && typeof value.presented === 'number') stream = value;
      if (value?.accept && typeof value.payloadBytes === 'number') history = value;
      if (value?.current?.cache && typeof value.current.currentBand === 'number') renderer = value.current;
      if (value?.current && typeof value.current === 'object' && 'since' in value.current && 'total' in value.current) stats = value.current;
    }
  }
  if (!stream || !history) throw new Error('Runtime diagnostics were not found');
  const records = [...history.records()];
  return {
    received: stream.received, presented: stream.presented, fresh: stream.fresh, draws: stream.draws,
    coalesced: stream.coalesced, overflows: stream.queueOverflows,
    records: history.count, payloadBytes: history.payloadBytes, cacheBytes: renderer?.cache.bytes ?? 0,
    oldestFrame: records[0]?.audibleFrame, secondFrame: records[1]?.audibleFrame, latestFrame: records.at(-1)?.audibleFrame,
    oldestId: records[0]?.id, latestId: records.at(-1)?.id, generation: history.latest()?.generation,
    pending: renderer?.pendingCount ?? 0, stats, status: document.querySelector('.visual-status')?.textContent,
    time: document.querySelector('.transport time')?.textContent,
  };
});
const checkHistory = sample => {
  // Every state in ten seconds plus the cutoff predecessor and a small reserve.
  assert(sample.payloadBytes <= (sample.records + 2) * (90400 + 24576));
  if (sample.records >= 2) assert(sample.secondFrame > sample.latestFrame - 10 * 32000);
  assert(sample.cacheBytes <= 16 * 1024 * 1024);
};
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); watch(page);
await page.goto(url, { waitUntil: 'networkidle' }); await load(page);
const modes = ['activity', 'activity-bits', 'bytes', 'bits', 'xor', 'xor-bits', 'entropy', 'entropy-bits'];
const performanceRows = [];
for (const rate of ['30 Hz', '60 Hz', 'Display']) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: rate === 'Display' ? /^Display ·/ : rate, exact: rate !== 'Display' }).click();
  await page.getByRole('button', { name: 'ARAM', exact: true }).click();
  for (const geometry of ['Map', 'Waterfall']) {
    await page.getByRole('button', { name: geometry, exact: true }).click();
    for (const mode of modes) for (const zoom of ['Fit', '1:1']) {
      await selectMemoryView(page, mode);
      await page.getByRole('button', { name: zoom, exact: true }).click();
      const before = await sample(page); const started = Date.now();
      await page.waitForTimeout(1100);
      const after = await sample(page); const seconds = (Date.now() - started) / 1000;
      const row = { rate, geometry, mode, zoom, presentedPerSecond: (after.presented - before.presented) / seconds,
        freshPerSecond: (after.fresh - before.fresh) / seconds, liveDrawsPerSecond: (after.draws - before.draws) / seconds,
        coalesced: after.coalesced - before.coalesced, overflows: after.overflows - before.overflows,
        payloadBytes: after.payloadBytes, cacheBytes: after.cacheBytes, status: after.status };
      assert(after.presented > before.presented); assert(after.draws > before.draws);
      checkHistory(after);
      assert.equal(after.overflows, before.overflows); assert.deepEqual(errors, []);
      performanceRows.push(row);
    }
  }
  console.log('Measured all modes and zoom levels at', rate);
}
await page.getByRole('button', { name: 'Waterfall', exact: true }).click();
await page.getByRole('button', { name: 'Fit', exact: true }).click();
const endurance = [];
for (let i = 0; i < 6; i++) {
  await selectMemoryView(page, modes[i % modes.length]);
  await page.waitForTimeout(10_000);
  const record = await sample(page); endurance.push(record);
  assert.equal(await page.locator('.now-playing .eyebrow').textContent(), 'Playing');
  checkHistory(record);
  assert(record.latestFrame - record.oldestFrame >= 10 * 32000, 'History must retain the full ten-second window');
  assert.equal(record.overflows, endurance[0].overflows); assert.deepEqual(errors, []);
  console.log('Waterfall endurance', (i + 1) * 10, 'seconds, records', record.records, 'oldest ID', record.oldestId);
}
assert(endurance.at(-1).payloadBytes <= Math.max(...endurance.map(s => s.records + 2)) * (90400 + 24576));
assert(endurance.at(-1).oldestId > endurance[0].oldestId + endurance[0].records, 'History must evict expired samples repeatedly');
await writeFile(artifactPath('performance.json'), JSON.stringify({ browser: browserName, viewport: '1280x800', performanceRows, endurance }, null, 2));
// Resize in Fit and in 1:1; preserve one-byte columns at every size.
const canvas = page.locator('.waterfall-plot canvas');
await page.setViewportSize({ width: 1100, height: 760 });
await page.waitForTimeout(100); assert.equal(await canvas.getAttribute('data-span'), '65536');
await page.getByRole('button', { name: '1:1', exact: true }).click();
await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(100);
assert.equal(await canvas.getAttribute('data-span'), await canvas.getAttribute('data-columns'));
const plot = page.getByLabel('Zoomable ARAM waterfall'); await plot.focus();
const oldStart = Number(await canvas.getAttribute('data-start')); await page.keyboard.press('ArrowRight');
assert(Number(await canvas.getAttribute('data-start')) > oldStart);
await page.getByRole('button', { name: 'Fit', exact: true }).click();
const bounds = await plot.boundingBox(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 10);
await page.mouse.wheel(0, -500); await page.waitForTimeout(150);
assert(Number(await canvas.getAttribute('data-span')) < 65536);
await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + 10, { steps: 4 }); await page.mouse.up();
assert(Number(await canvas.getAttribute('data-start')) >= 0);
await page.getByRole('button', { name: 'Pause', exact: true }).click(); await page.waitForTimeout(150);
const paused = await sample(page); await page.waitForTimeout(300); assert.equal((await sample(page)).records, paused.records);
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page.locator('.setting-row select').selectOption('grayscale');
const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export settings', exact: true }).click();
const exported = JSON.parse(await readFile(await (await downloadPromise).path(), 'utf8'));
assert.equal(exported.version, 3); assert.equal(exported.settings.geometry, 'waterfall');
await page.locator('input[accept=".json,application/json"]').setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
await page.getByRole('button', { name: 'ARAM', exact: true }).click();
await page.getByRole('button', { name: 'Play', exact: true }).click(); await page.waitForTimeout(200);
const prior = await sample(page);
await page.locator('input[accept=".spc"]').setInputFiles({ name: 'invalid.spc', mimeType: 'application/octet-stream', buffer: Buffer.alloc(64) });
await page.locator('.track-list button').first().click(); await page.waitForTimeout(300);
assert.equal((await sample(page)).generation, prior.generation);
assert((await sample(page)).latestId > prior.latestId, 'Failed replacement must preserve playback history');
await page.getByRole('button', { name: 'Restart', exact: true }).click(); await page.waitForTimeout(300);
assert((await sample(page)).generation > prior.generation);
await page.getByRole('button', { name: 'Voices', exact: true }).click(); await page.waitForTimeout(200);
await page.getByRole('button', { name: 'DSP', exact: true }).click(); await page.waitForTimeout(200);
await page.getByRole('button', { name: 'ARAM', exact: true }).click();
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.getByLabel('Memory measurement').selectOption('activity');
await page.screenshot({ path: artifactPath('waterfall-activity.png') });
await page.close();
// Standalone local file: DPR 2, phone/touch gestures, all modes, settings import.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const local = await phone.newPage(); watch(local);
await local.goto(pathToFileURL(resolve('Visual-SPC-Player.html')).href, { waitUntil: 'networkidle' }); await load(local);
await local.getByRole('button', { name: 'Waterfall', exact: true }).click();
for (const mode of modes) { await selectMemoryView(local, mode); await local.waitForTimeout(80); }
await local.getByRole('button', { name: '1:1', exact: true }).click();
const localCanvas = local.locator('.waterfall-plot canvas');
assert.equal(Number(await localCanvas.getAttribute('width')), Number(await localCanvas.getAttribute('data-columns')) * Number(await localCanvas.getAttribute('data-pixels-per-bucket')) * 2);
const phonePlot = await local.getByLabel('Zoomable ARAM waterfall').boundingBox();
const cdp = await phone.newCDPSession(local);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
const x = phonePlot.x + phonePlot.width / 2, y = phonePlot.y + 30;
await touch('touchStart', [[x - 40, y, 1], [x + 40, y, 2]]);
await touch('touchMove', [[x - 20, y, 1], [x + 20, y, 2]]); await touch('touchEnd', []); await local.waitForTimeout(100);
assert(Number(await localCanvas.getAttribute('data-span')) > Number(await localCanvas.getAttribute('data-columns')));
await local.touchscreen.tap(x, y); assert.match(await local.locator('.waterfall-inspector').textContent(), /\$/);
await local.getByRole('button', { name: 'Map', exact: true }).click();
await local.getByRole('button', { name: 'Waterfall', exact: true }).click();
await local.getByRole('button', { name: 'Pause', exact: true }).click();
await local.getByRole('button', { name: 'Restart', exact: true }).click();
await local.getByRole('button', { name: 'Play', exact: true }).waitFor();
await local.getByRole('button', { name: 'Settings', exact: true }).click();
await local.locator('input[accept=".json,application/json"]').setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
await local.getByRole('button', { name: 'ARAM', exact: true }).click();
assert.equal(await local.getByRole('button', { name: 'Waterfall', exact: true }).getAttribute('aria-pressed'), 'true');
assert.equal(await local.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
await phone.close(); assert.deepEqual(errors, []); await browser.close();
await writeFile(artifactPath('performance.json'), JSON.stringify({ browser: browserName, viewport: '1280x800', performanceRows, endurance }, null, 2));
console.log('Waterfall matrix, 60-second capture, and standalone/touch/DPR checks passed');
