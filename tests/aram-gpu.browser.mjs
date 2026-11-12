import { strict as assert } from 'node:assert';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../scripts/browser-environment.mjs';

// A real graphics context verifies shader output and ring chronology. No SPC,
// audio device, generated WASM, or full application build is required.
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
let browser;
try {
  browser = await chromium.launch(browserLaunchOptions);
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  const results = await page.evaluate(async () => {
    const { NumericGpu } = await import('/src/aram/numericGpu.ts');
    const { renderAram } = await import('/src/aram/renderer.ts');
    const mapCanvas = document.createElement('canvas'), map = NumericGpu.create(mapCanvas, false);
    if (!map) throw new Error('WebGL 2 memory renderer could not initialize');
    const gl = map.gl, ram = Uint8Array.from({ length: 65536 }, (_, i) => i & 1 ? 255 : 0), access = new Uint8Array(24576), held = new Uint8Array(65536), entropy = new Float32Array(2048);
    map.uploadMap(ram, access, held, entropy);
    const pixel = (renderer, x, y) => { const rgba = new Uint8Array(4); renderer.gl.readPixels(x, renderer.canvas.height - 1 - y, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, rgba); return [...rgba]; };
    const colors = {};
    for (const sampling of ['nearest', 'smooth', 'area']) { map.draw({ mode: 'bytes', palette: 'grayscale', sampling }, 128, 128, 0, { offsetX: 0, offsetY: 0, scale: .5 }); colors[sampling] = pixel(map, 20, 20); }
    map.draw({ mode: 'bytes', palette: 'spectrum', sampling: 'area' }, 128, 128, 0, { offsetX: 0, offsetY: 0, scale: .5 }); colors.nonlinear = pixel(map, 20, 20);
    const { bytePalette } = await import('/src/aram/palettes.ts');
    ram.fill(0x80); map.uploadMap(ram, access, held, entropy);
    map.draw({ mode: 'xor-bits', palette: 'grayscale', sampling: 'area' }, 1024, 512, 0, { scale: 1, offsetX: 0, offsetY: 0 }, true);
    const xorLanes = [pixel(map, 0, 0), pixel(map, 1, 0), pixel(map, 3, 1)];
    const ring = NumericGpu.create(document.createElement('canvas'), true); if (!ring) throw new Error('Waterfall WebGL 2 renderer could not initialize');
    ring.configureRows(2, 4);
    const row = (value, valid = true) => ({ lanes: 1, values: new Float32Array([value, value]), valid });
    ring.uploadRow(5, row(100), 2); ring.uploadRow(4, row(0), 2); ring.uploadRow(3, row(0, false), 2); ring.uploadRow(2, row(255), 2);
    ring.draw({ mode: 'bytes', palette: 'grayscale', sampling: 'nearest' }, 2, 4, 5);
    const chronological = [0, 1, 2, 3].map(y => pixel(ring, 0, y));
    ring.draw({ mode: 'bytes', palette: 'grayscale', sampling: 'nearest', temporal: true, temporalMs: 30, framesPerBand: 320 }, 2, 4, 5);
    const filtered = pixel(ring, 0, 0), gap = pixel(ring, 0, 2);
    ring.uploadRow(5, { ...row(1), byteValues: new Float32Array([200, 200]) }, 2); ring.uploadRow(4, { ...row(2), byteValues: new Float32Array([0, 0]) }, 2);
    ring.draw({ mode: 'activity', activityByteBackground: false, palette: 'grayscale', temporal: true, temporalMs: 30, framesPerBand: 320 }, 2, 4, 5);
    const activity = pixel(ring, 0, 0);
    const { MemoryHistory } = await import('/src/aram/history.ts');
    const { WaterfallRenderer } = await import('/src/aram/waterfallRenderer.ts');
    const { makeSnapshot } = await import('/tests/helpers/snapshots.ts');
    const history = new MemoryHistory(); history.reset(1);
    history.accept(makeSnapshot(1, { frame: 0 }), 0);
    history.accept(makeSnapshot(2, { frame: 200, ram: bytes => bytes.fill(200) }), 0);
    const visible = document.createElement('canvas'), waterfall = new WaterfallRenderer(visible, history, true);
    waterfall.configure({ mode: 'bytes', palette: 'grayscale', columns: 2, height: 4, framesPerBand: 100, window: { start: 0, span: 2 } });
    waterfall.update(); waterfall.flush(Infinity, false);
    const deferred = { rows: waterfall.pendingRows, before: waterfall.pendingCount };
    waterfall.present(); deferred.after = waterfall.pendingCount;
    deferred.pixel = pixel({ canvas: visible, gl: visible.getContext('webgl2') }, 0, 1);
    waterfall.dispose();
    const sampleTarget = new Uint8ClampedArray(1024 * 512 * 4);
    const startedCpu = performance.now(); for (let i = 0; i < 60; i++) renderAram('bits', ram, null, null, i, 'spectrum', sampleTarget); const cpuMs = performance.now() - startedCpu;
    const startedGpu = performance.now(); for (let i = 0; i < 60; i++) { map.uploadMap(ram, access, held, entropy); map.draw({ mode: 'bits', palette: 'spectrum' }, 1024, 512, 0, { scale: 1, offsetX: 0, offsetY: 0 }); } const gpuSubmissionMs = performance.now() - startedGpu;
    const error = gl.getError(); map.dispose(); ring.dispose();
    return { colors, nonlinearExpected: bytePalette(128, 'spectrum'), xorLanes, chronological, filtered, gap, activity, deferred, error, cpuMs, gpuSubmissionMs };
  });
  assert.deepEqual(results.colors.nearest, [255, 255, 255, 255]);
  assert.deepEqual(results.colors.smooth, [128, 128, 128, 255]);
  assert.deepEqual(results.colors.area, [128, 128, 128, 255]);
  assert.deepEqual(results.colors.nonlinear, results.nonlinearExpected);
  assert.deepEqual(results.xorLanes, [[255, 255, 255, 255], [0, 0, 0, 255], [0, 0, 0, 255]]);
  assert.deepEqual(results.chronological, [[100, 100, 100, 255], [0, 0, 0, 255], [16, 23, 34, 255], [255, 255, 255, 255]]);
  assert.deepEqual(results.filtered, [57, 57, 57, 255]);
  assert.deepEqual(results.gap, [16, 23, 34, 255]);
  assert.deepEqual(results.activity, [42, 168, 255, 255]);
  assert.deepEqual(results.deferred, { rows: 0, before: 1, after: 0, pixel: [200, 200, 200, 255] });
  assert.equal(results.error, 0);
  console.log(JSON.stringify(results, null, 2));
} finally { await browser?.close(); await server.close(); }
