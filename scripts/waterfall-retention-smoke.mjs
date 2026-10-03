import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { browserLaunchOptions } from './browser-environment.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { selectMemoryView } from './browser-view-helpers.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch(browserLaunchOptions);
const errors = [];
const image = new Uint8Array(0x10180);
image.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'));
image.set([0x1a, 0x1a, 0x1a, 0x1e], 0x21); image[0x26] = 2;
image.set([0x2f, 0xfe], 0x300);

// Test-only access to the actual owned history and renderer; no product debug API.
const runtime = () => {
  const element = document.querySelector('.waterfall-plot');
  let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
  let stream, history, renderer;
  for (; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
    const value = Array.isArray(hook.memoizedState) ? hook.memoizedState[0] : hook.memoizedState;
    if (value?.publish && typeof value.presented === 'number') stream = value;
    if (value?.accept && typeof value.payloadBytes === 'number') history = value;
    if (value?.current?.cache && typeof value.current.currentBand === 'number') renderer = value.current;
  }
  return { stream, history, renderer };
};

try {
  for (const [name, url, options] of [
    ['desktop', process.env.SPC_PREVIEW_URL || 'http://127.0.0.1:4173/', { viewport: { width: 1400, height: 1050 } }],
    ['phone', process.env.SPC_PREVIEW_URL || 'http://127.0.0.1:4173/', { viewport: { width: 590, height: 1280 }, hasTouch: true, deviceScaleFactor: 2 }],
    ['standalone', pathToFileURL(resolve('Visual-SPC-Player.html')).href, { viewport: { width: 1280, height: 850 } }],
  ]) {
    const page = await browser.newPage(options);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.locator('input[accept=".spc"]').setInputFiles({ name: 'retention.spc', mimeType: 'application/octet-stream', buffer: Buffer.from(image) });
    await page.locator('.track-list button').first().click();
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    if (name === 'desktop') await page.waitForTimeout(12000);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Waterfall', exact: true }).click();
    await selectMemoryView(page, 'bytes');
    await page.evaluate('window.retentionRuntime = ' + runtime.toString());
    if (name === 'desktop') {
      await page.getByLabel('Waterfall time span').selectOption('10');
      await page.waitForFunction(() => window.retentionRuntime().renderer.pendingCount === 0);
      const live = await page.evaluate(() => {
        const { history, renderer, stream } = window.retentionRuntime();
        const records = [...history.records()];
        return { seconds: (history.latest().audibleFrame - records[0].audibleFrame) / 32000,
          bottomValid: renderer.inspect(0, renderer.config.height - 1).row.valid,
          records: history.count, payloadBytes: history.payloadBytes, overflows: stream.queueOverflows };
      });
      assert(live.seconds >= 10); assert(live.bottomValid); assert.equal(live.overflows, 0);
      assert(live.payloadBytes <= (live.records + 2) * (90400 + 24576));
      console.log('Live playback retained the full window', live);
    }
    const capture = await page.evaluate(() => {
      const { stream, history } = window.retentionRuntime();
      const snapshot = { ...stream.latest, payload: stream.latest.payload.slice(0) };
      const ram = new Uint8Array(snapshot.payload, 0, 65536); ram.fill(85);
      const state = new DataView(snapshot.payload, 65536 + 24576);
      snapshot.combinedActivity = new Uint8Array(24576); snapshot.combinedActivity.fill(255, 8192, 16384);
      history.reset(snapshot.generation);
      for (let i = 0; i <= 2880; i++) {
        snapshot.sequence = i; snapshot.audibleFrame = i * 32000 / 240;
        state.setFloat64(24, snapshot.audibleFrame, true); ram[0] = i & 255;
        if (!history.accept(snapshot, 0)) throw new Error('Synthetic capture was rejected');
      }
      stream.publish(snapshot);
      return { count: history.count, payloadBytes: history.payloadBytes };
    });
    assert(capture.count >= 2401 && capture.count <= 2402);
    const modes = name === 'desktop' ? ['bytes', 'activity', 'activity-bits', 'bits', 'xor', 'xor-bits', 'entropy', 'entropy-bits'] : ['bytes'];
    for (const mode of modes) {
      await selectMemoryView(page, mode);
      let height;
      if (mode.startsWith('activity')) await page.getByLabel(/^Show (bytes|bits) underneath$/).check();
      for (const seconds of [2, 5, 10]) {
        await page.getByLabel('Waterfall time span').selectOption(String(seconds));
        await page.waitForFunction(() => window.retentionRuntime().renderer.pendingCount === 0, null, { timeout: 30000 });
        const result = await page.evaluate(() => {
          const { history, renderer } = window.retentionRuntime();
          const canvas = document.querySelector('.waterfall-plot canvas');
          const config = renderer.config;
          const checks = [1, Math.floor(config.height / 2), config.height - 1].map(y => renderer.inspect(0, y).row.valid);
          const ctx = canvas.getContext('2d');
          const pixel = ctx.getImageData(0, canvas.height - 2, 1, 1).data;
          return { height: canvas.height, plotHeight: canvas.parentElement.clientHeight, dpr: devicePixelRatio,
            pending: renderer.pendingCount, checks, records: history.count, bottomPixel: [...pixel] };
        });
        if (height === undefined) height = result.height;
        assert.equal(result.height, height, 'Changing the time window must preserve the plot height');
        assert.equal(result.height, result.plotHeight * result.dpr);
        assert.deepEqual(result.checks, [true, true, true], 'The bottom of every window needs retained data and an XOR baseline');
        assert.equal(result.records, capture.count, 'Changing the window must not clear or downsample history');
        if (mode === 'bytes' || mode === 'activity') assert.notDeepEqual(result.bottomPixel, [16, 23, 34, 255], 'The displayed bottom pixel must be populated');
        const bounds = await page.getByLabel('Zoomable ARAM waterfall').boundingBox();
        await page.mouse.move(bounds.x + 1, bounds.y + bounds.height - 1);
        const inspection = await page.locator('.waterfall-inspector').textContent();
        assert(!/unavailable|No retained sample|NaN/.test(inspection), inspection);
      }
    }
    // Snapshot ownership and the latest Map state survive time-based eviction.
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await page.getByRole('button', { name: 'Waterfall', exact: true }).click();
    assert.equal(await page.evaluate(() => window.retentionRuntime().history.count), capture.count);
    console.log(name, 'all window heights and retained coverage passed', capture);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('240 Hz synthetic capture: desktop, phone, and standalone retention checks passed');
} finally { await browser.close(); }
