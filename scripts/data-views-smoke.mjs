import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { artifactPath, browserLaunchOptions } from './browser-environment.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectMemoryView, memoryRuntime } from './browser-view-helpers.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch(browserLaunchOptions);
const image = new Uint8Array(0x10180);
image.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'));
image.set([0x1a, 0x1a, 0x1a, 0x1e], 0x21); image[0x26] = 2;
image.set([0x2f, 0xfe], 0x300);
const errors = [];
const white = [255, 255, 255, 255], black = [0, 0, 0, 255];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const ready = async page => { await settle(page); await page.waitForFunction(() => window.memoryRuntime().renderer.pendingCount === 0); };
const inject = (page, fixture) => page.evaluate(fixture => {
  const { stream, history } = window.memoryRuntime();
  const snapshot = { ...stream.latest, payload: stream.latest.payload.slice(0), combinedActivity: new Uint8Array(24576) };
  const ram = new Uint8Array(snapshot.payload, 0, 65536), state = new DataView(snapshot.payload, 65536 + 24576);
  if (fixture === 'activity') snapshot.combinedActivity.fill(255, 0, 8192);
  history.reset(snapshot.generation);
  for (let i = 0; i <= 301; i++) {
    if (fixture === 'activity') ram.fill(0x80);
    else if (fixture === 'xor') ram.fill(i & 1 ? 0x8f : 0x80);
    else for (let a = 0; a < ram.length; a++) ram[a] = a & 1;
    snapshot.sequence = i; snapshot.audibleFrame = i * 32000 / 30;
    state.setFloat64(24, snapshot.audibleFrame, true);
    if (!history.accept(snapshot, 0)) throw new Error('Fixture capture rejected');
  }
  stream.publish(snapshot);
  return { count: history.count, requestId: snapshot.requestId };
}, fixture);
const geometry = page => page.locator('.waterfall-plot canvas').evaluate(c => ({
  top: c.parentElement.getBoundingClientRect().top, height: c.parentElement.clientHeight,
  width: c.width, canvasHeight: c.height, start: c.dataset.start, span: c.dataset.span, columns: c.dataset.columns,
}));
const inspect = (page, x, y, map = false) => page.locator(map ? '.map-stage' : '.waterfall-plot').evaluate((plot, point) => {
  const bounds = plot.getBoundingClientRect();
  plot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: bounds.left + point.x, clientY: bounds.top + point.y }));
  return document.querySelector(point.map ? '.map-metric-inspector' : '.waterfall-inspector').textContent;
}, { x, y, map });
const mapPixel = (page, x, y) => page.locator('.map-stage canvas').evaluate((c, point) => [...c.getContext('2d').getImageData(point.x, point.y, 1, 1).data], { x, y });
const waterfallPixel = (page, lane = 0) => page.locator('.waterfall-plot canvas').evaluate((c, lane) => {
  const config = window.memoryRuntime().renderer.config, lanes = Number(c.dataset.pixelsPerBucket);
  const logicalWidth = config.columns * lanes;
  return [...c.getContext('2d').getImageData(Math.floor((8 * lanes + lane + .5) * c.width / logicalWidth), Math.floor(20.5 * c.height / config.height), 1, 1).data];
}, lane);
try {
  for (const c of [
    { name: 'desktop', width: 1400, height: 1050, dpr: 1 },
    { name: 'phone', width: 390, height: 844, dpr: 3 },
    { name: 'standalone', width: 590, height: 1280, dpr: 2, local: true },
  ]) {
    const page = await browser.newPage({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: c.dpr, hasTouch: c.width < 720 });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(c.local ? pathToFileURL(resolve('Visual-SPC-Player.html')).href : process.env.SPC_PREVIEW_URL || 'http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
    assert.deepEqual(await page.getByLabel('Memory measurement').locator('option').allTextContents(), ['Activity', 'Data', 'Entropy']);
    await page.locator('input[accept=".spc"]').setInputFiles({ name: 'data-controls.spc', mimeType: 'application/octet-stream', buffer: Buffer.from(image) });
    await page.locator('.track-list button').first().click();
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor(); await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Pause', exact: true }).click(); await page.waitForTimeout(100);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.setting-row select').selectOption('grayscale');
    await page.getByRole('button', { name: 'ARAM', exact: true }).click();
    await page.evaluate('window.memoryRuntime = ' + memoryRuntime.toString());
    const captured = await inject(page, 'xor');
    await selectMemoryView(page, 'bytes'); await settle(page);
    assert.deepEqual(await mapPixel(page, 100, 100), [143, 143, 143, 255]);
    await selectMemoryView(page, 'xor'); await settle(page);
    assert.deepEqual(await mapPixel(page, 100, 100), [15, 15, 15, 255]);
    await selectMemoryView(page, 'xor-bits'); await settle(page);
    assert.deepEqual(await mapPixel(page, 400, 200), black); // unchanged bit 7
    assert.deepEqual(await mapPixel(page, 403, 201), white); // changed bit 0
    await page.getByRole('button', { name: 'Waterfall', exact: true }).click();
    await page.getByRole('button', { name: '1:1', exact: true }).click(); await ready(page);
    assert.deepEqual(await waterfallPixel(page, 0), black);
    assert.deepEqual(await waterfallPixel(page, 7), white);
    const before = await geometry(page);
    assert.equal(before.span, before.columns, '1:1 uses one byte per bucket and one pixel per bit');
    await page.getByLabel('XOR changes only').uncheck(); await ready(page);
    assert.deepEqual(await geometry(page), before, 'XOR changes colors without changing pixel dimensions or address range');
    assert.deepEqual(await waterfallPixel(page, 0), white); // data bit 7 is always set
    await page.getByLabel('XOR changes only').check(); await ready(page);
    assert.deepEqual(await geometry(page), before);
    assert.match(await inspect(page, 8 * 8 + 7.5, 20.5), /Bit 0: 100\.0% changed/);
    await selectMemoryView(page, 'xor'); await page.getByRole('button', { name: '1:1', exact: true }).click(); await ready(page);
    assert.deepEqual(await waterfallPixel(page), [15, 15, 15, 255]);
    assert.match(await inspect(page, 8.5, 20.5), /XOR \$0F/);
    assert.deepEqual(await page.evaluate(() => ({ count: window.memoryRuntime().history.count, requestId: window.memoryRuntime().stream.latest.requestId })), captured,
      'Presentation controls preserve retained captures and the emulator request');

    await inject(page, 'entropy');
    await selectMemoryView(page, 'entropy'); await ready(page);
    assert.deepEqual(await waterfallPixel(page), [32, 32, 32, 255]); // 1 of 8 bits/byte
    assert.match(await inspect(page, 8.5, 20.5), /1\.000 bits\/byte/);
    await selectMemoryView(page, 'entropy-bits'); await page.getByRole('button', { name: '1:1', exact: true }).click(); await ready(page);
    assert.deepEqual(await waterfallPixel(page, 0), black);
    assert.deepEqual(await waterfallPixel(page, 7), white);
    assert.match(await inspect(page, 8 * 8 + 7.5, 20.5), /Bit 0: 1\.000 bits/);
    if (process.env.SPC_ARTIFACT_DIR) await page.screenshot({ path: artifactPath(`entropy-bits-${c.name}.png`) });
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click(); await settle(page);
    assert.deepEqual(await mapPixel(page, 400, 200), black);
    assert.deepEqual(await mapPixel(page, 403, 201), white);
    // Convert the logical tile into the fitted viewport's pointer coordinates.
    const point = await page.locator('.map-stage canvas').evaluate(c => {
      const b = c.getBoundingClientRect(), stage = c.parentElement.getBoundingClientRect();
      return { x: b.left - stage.left + 403.5 * b.width / c.width, y: b.top - stage.top + 201.5 * b.height / c.height };
    });
    assert.match(await inspect(page, point.x, point.y, true), /Bit 0 · 1\.000 bits.*256-byte block/);
    await selectMemoryView(page, 'entropy'); await settle(page);
    assert.deepEqual(await mapPixel(page, 100, 100), [32, 32, 32, 255]);
    await selectMemoryView(page, 'entropy-bits'); await settle(page);
    assert.deepEqual(await mapPixel(page, 403, 201), white, 'Paused switches must use the correct entropy calculation');

    await inject(page, 'activity');
    await selectMemoryView(page, 'activity-bits');
    await page.getByLabel('Show bits underneath').check(); await settle(page);
    assert.deepEqual(await mapPixel(page, 400, 200), [46, 162, 242, 255]);
    assert.deepEqual(await mapPixel(page, 403, 201), [39, 155, 235, 255]);
    await page.getByLabel('Show bits underneath').uncheck(); await settle(page);
    assert.deepEqual(await mapPixel(page, 400, 200), [42, 168, 255, 255]);
    assert.deepEqual(await mapPixel(page, 403, 201), [42, 168, 255, 255]);
    await page.getByRole('button', { name: 'Waterfall', exact: true }).click();
    await page.getByRole('button', { name: '1:1', exact: true }).click(); await ready(page);
    const activityGeometry = await geometry(page);
    assert.equal(activityGeometry.span, activityGeometry.columns);
    await page.getByLabel('Show bits underneath').check(); await ready(page);
    assert.deepEqual(await geometry(page), activityGeometry);
    assert.deepEqual(await waterfallPixel(page, 0), [46, 162, 242, 255]);
    assert.deepEqual(await waterfallPixel(page, 7), [39, 155, 235, 255]);
    assert.match(await inspect(page, 8 * 8 + .5, 20.5), /Read · Bit 7: 100\.0% set/);
    assert.match(await inspect(page, 8 * 8 + 7.5, 20.5), /Read · Bit 0: 0\.0% set/);
    if (process.env.SPC_ARTIFACT_DIR) await page.screenshot({ path: artifactPath(`activity-bits-${c.name}.png`) });
    await selectMemoryView(page, 'activity'); await ready(page);
    assert.equal(await page.getByLabel('Show bytes underneath').isChecked(), true);
    assert.deepEqual(await waterfallPixel(page), [42, 158, 238, 255]);
    await selectMemoryView(page, 'activity-bits'); await ready(page);
    assert.equal(await page.getByLabel('Show bits underneath').isChecked(), true);
    assert.deepEqual(await waterfallPixel(page, 0), [46, 162, 242, 255]);

    await page.getByLabel('Memory measurement').selectOption('data');
    assert.equal(await page.getByLabel('XOR changes only').isChecked(), true);
    await selectMemoryView(page, 'xor-bits');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export settings', exact: true }).click();
    const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    assert.equal(exported.version, 3);
    assert.equal(exported.settings.activityUnit, 'bit');
    assert.equal(exported.settings.activityByteBackground, true);
    assert.deepEqual([exported.settings.mode, exported.settings.dataUnit, exported.settings.dataXor, exported.settings.entropyUnit], ['data', 'bit', true, 'bit']);
    await page.reload();
    assert.equal(await page.getByLabel('Memory measurement').inputValue(), 'data');
    assert.equal(await page.locator('[aria-label="Data representation"]').getByRole('button', { name: 'Bit', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('XOR changes only').isChecked(), true);
    await page.getByLabel('Memory measurement').selectOption('activity');
    assert.equal(await page.locator('[aria-label="Activity representation"]').getByRole('button', { name: 'Bit', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('Show bits underneath').isChecked(), true);
    await page.getByLabel('Memory measurement').selectOption('entropy');
    assert.equal(await page.locator('[aria-label="Entropy representation"]').getByRole('button', { name: 'Bit', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    for (const [legacy, unit, xor] of [['bits', 'Bit', false], ['xor', 'Byte', true]]) {
      const older = { ...exported, version: 2, settings: { ...exported.settings, mode: legacy } };
      await page.locator('input[accept=".json,application/json"]').setInputFiles({ name: 'legacy-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(older)) });
      await page.getByRole('button', { name: 'ARAM', exact: true }).click();
      assert.equal(await page.getByLabel('Memory measurement').inputValue(), 'data');
      assert.equal(await page.locator('[aria-label="Data representation"]').getByRole('button', { name: unit, exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByLabel('XOR changes only').isChecked(), xor);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
    }
    console.log(c.name, 'Activity/Data/XOR/Entropy pixels, geometry, inspection, and settings passed');
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
