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
const measure = page => page.evaluate(() => {
  const stage = document.querySelector('.aram-stage:not([hidden])');
  const plot = stage.querySelector('.waterfall-plot') ?? stage;
  const canvas = plot.querySelector('canvas');
  const bounds = plot.getBoundingClientRect();
  const legend = document.querySelector('.legend');
  return { top: bounds.top, height: bounds.height, width: bounds.width,
    canvasWidth: canvas.width, canvasHeight: canvas.height, canvasStyle: canvas.getAttribute('style'),
    columns: canvas.dataset.columns, start: canvas.dataset.start, span: canvas.dataset.span,
    legendHeight: legend.getBoundingClientRect().height,
    footerHeight: document.querySelector('.visual-status').getBoundingClientRect().height };
});
const settle = async page => {
  // Let React, ResizeObserver, and the canvas reconfiguration commit together.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
try {
  const cases = [
    { name: 'phone', width: 390, height: 844, dpr: 3 },
    { name: 'wide phone', width: 590, height: 1280, dpr: 2 },
    { name: 'tablet', width: 960, height: 900, dpr: 1 },
    { name: 'desktop', width: 1400, height: 1050, dpr: 1 },
    { name: 'standalone phone', width: 390, height: 844, dpr: 2, local: true },
  ];
  for (const c of cases) {
    const page = await browser.newPage({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: c.dpr, hasTouch: c.width <= 720 });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(c.local ? pathToFileURL(resolve('Visual-SPC-Player.html')).href : process.env.SPC_PREVIEW_URL || 'http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
    await page.locator('input[accept=".spc"]').setInputFiles({ name: 'layout.spc', mimeType: 'application/octet-stream', buffer: Buffer.from(image) });
    await page.locator('.track-list button').first().click();
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.waitForTimeout(150);
    for (const unit of ['byte', 'bit']) {
      await selectMemoryView(page, unit === 'bit' ? 'activity-bits' : 'activity');
      for (const geometry of ['Waterfall', 'Map']) {
        await page.getByRole('button', { name: geometry, exact: true }).click();
        for (const zoom of ['Fit', '1:1']) {
          await page.getByRole('button', { name: zoom, exact: true }).click();
          for (const seconds of geometry === 'Waterfall' ? [2, 5, 10] : [5]) {
            if (geometry === 'Waterfall') await page.getByLabel('Waterfall time span').selectOption(String(seconds));
            const toggle = page.getByLabel(unit === 'bit' ? 'Show bits underneath' : 'Show bytes underneath');
            await toggle.uncheck(); await settle(page); const plain = await measure(page);
            await toggle.check(); await settle(page); const background = await measure(page);
            assert.deepEqual(background, plain, 'The data underlay must change colors without resizing the plot, its pixels, address buckets, or legend');
            if (geometry === 'Waterfall') {
              // Dispatch to the plot so touch-capable browser contexts inspect
              // the same logical pixel without depending on mouse/touch emulation.
              const inspect = () => page.getByLabel('Zoomable ARAM waterfall').evaluate(plot => {
                const bounds = plot.getBoundingClientRect();
                plot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: bounds.left + 5, clientY: bounds.top + 20 }));
                const text = document.querySelector('.waterfall-inspector').textContent;
                if (!text.startsWith('$')) throw new Error('The waterfall inspector did not produce a pointer reading: ' + text);
                return text.split(' · ').slice(0, 2).join(' · ');
              });
              const paired = await inspect(); await toggle.uncheck(); await settle(page);
              assert.equal(await inspect(), paired, 'The same pixel must resolve to the same address and time interval');
            }
          }
        }
      }
    }
    await page.getByLabel('Show bits underneath').check();
    assert.equal(await page.locator('.legend').evaluate(legend => {
      legend.scrollLeft = legend.scrollWidth;
      return legend.scrollWidth <= legend.clientWidth || legend.scrollLeft > 0;
    }), true, 'Overflowing legend text remains available through horizontal scrolling');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    console.log(c.name, 'Byte and Bit: unchanged plot, canvas, buckets, and time intervals passed');
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('Activity underlay preserves Map and Waterfall geometry on phone, tablet, desktop, and standalone');
} finally { await browser.close(); }
