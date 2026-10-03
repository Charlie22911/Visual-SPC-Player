import { expect, test } from 'vitest';
import { MemoryHistory } from '../src/aram/history';
import { composeBand, WaterfallRenderer } from '../src/aram/waterfallRenderer';
import { activityBytePalette, activityBitPalette, activityPalette, bytePalette, metricPalette } from '../src/aram/palettes';
import { makeSnapshot } from './helpers/snapshots';
import { isBitMode, type AramMode } from '../src/aram/types';

function raster() {
  let data = new Uint8ClampedArray(0);
  const canvas = { width: 0, height: 0, getContext: () => { ensure(); return context; } };
  function ensure() { if (data.length !== canvas.width * canvas.height * 4) data = new Uint8ClampedArray(canvas.width * canvas.height * 4); }
  const context = {
    fillStyle: '',
    fillRect: (x: number, y: number, w: number, h: number) => { ensure(); for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) data.set([16, 23, 34, 255], (row * canvas.width + col) * 4); },
    createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    clearRect: (x: number, y: number, w: number, h: number) => { ensure(); for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) data.fill(0, (row * canvas.width + col) * 4, (row * canvas.width + col + 1) * 4); },
    putImageData: (image: ImageData, x: number, y: number) => { ensure(); for (let row = 0; row < image.height; row++) for (let col = 0; col < image.width; col++) if (y + row >= 0 && y + row < canvas.height) data.set(image.data.subarray((row * image.width + col) * 4, (row * image.width + col + 1) * 4), ((y + row) * canvas.width + x + col) * 4); },
    drawImage: (_source: unknown, sx: number, sy: number, w: number, h: number, dx: number, dy: number) => { ensure(); const copy = data.slice(); for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) data.set(copy.subarray(((sy + row) * canvas.width + sx + col) * 4, ((sy + row) * canvas.width + sx + col + 1) * 4), ((dy + row) * canvas.width + dx + col) * 4); },
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, pixels: () => data };
}

test('reset clears old-generation pixels before a new sample arrives', () => {
  const history = new MemoryHistory(3); history.reset(1);
  const target = raster(), renderer = new WaterfallRenderer(target.canvas, history);
  renderer.configure({ mode: 'bytes', columns: 2, window: { start: 0, span: 2 }, height: 4, framesPerBand: 128, palette: 'grayscale' });
  history.accept(makeSnapshot(1, { frame: 0 }), 0);
  history.accept(makeSnapshot(2, { frame: 128, ram: r => r.fill(255) }), 0);
  renderer.update(); renderer.flush(Infinity);
  expect(target.pixels().some(v => v === 255)).toBe(true);
  history.reset(2); renderer.update(); renderer.flush(Infinity);
  expect([...target.pixels()]).toEqual(Array.from({ length: 8 }, () => [16, 23, 34, 255]).flat());
});

test('backfill discards superseded parameters and resolves overwritten records afresh', () => {
  const history = new MemoryHistory(2); history.reset(1);
  const target = raster(), renderer = new WaterfallRenderer(target.canvas, history);
  const options = { mode: 'bytes' as const, columns: 2, window: { start: 0, span: 2 }, height: 8, framesPerBand: 128, palette: 'grayscale' as const };
  history.accept(makeSnapshot(1, { frame: 0 }), 0);
  history.accept(makeSnapshot(2, { frame: 128, ram: r => r.fill(255) }), 0);
  renderer.configure(options); renderer.update(); renderer.flush(0);
  expect(renderer.pendingCount).toBeGreaterThan(0);
  renderer.configure({ ...options, mode: 'entropy' });
  expect(renderer.pendingCount).toBe(0);
  history.accept(makeSnapshot(3, { frame: 256, ram: r => r.fill(127) }), 0);
  history.accept(makeSnapshot(4, { frame: 384, ram: r => { for (let a = 0; a < 65536; a++) r[a] = a & 255; } }), 0);
  renderer.update(); renderer.flush(Infinity);
  expect(renderer.pendingCount).toBe(0);
  // The latest interval has entropy eight; the older retained constant block
  // has entropy zero. Neither overwritten byte row can reappear during work.
  expect([...target.pixels().subarray(8, 16)]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
  expect([...target.pixels().subarray(16, 24)]).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  expect([...target.pixels().subarray(24, 32)]).toEqual([16, 23, 34, 255, 16, 23, 34, 255]);
});
test('constant bytes produce horizontal bit groups and steady vertical time trails', () => {
  const history = new MemoryHistory(6); history.reset(1);
  const target = raster(), renderer = new WaterfallRenderer(target.canvas, history);
  renderer.configure({ mode: 'bits', columns: 2, window: { start: 0, span: 2 }, height: 4, framesPerBand: 100, palette: 'grayscale' });
  for (const [i, frame] of [0, 50, 150, 250].entries()) {
    history.accept(makeSnapshot(i + 1, { frame, ram: r => { r[0] = 0x80; r[1] = 0x01; } }), 0);
  }
  renderer.update(); renderer.flush(Infinity);
  expect(target.canvas.width).toBe(16);
  const levels = (y: number) => Array.from({ length: 16 }, (_, x) => target.pixels()[(y * 16 + x) * 4]);
  const steady = [255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255];
  expect(levels(0)).toEqual(steady);
  expect(levels(1)).toEqual(steady);
  expect(levels(2)).toEqual(steady);
  expect(renderer.inspect(0, 0)).toMatchObject({ column: 0, lane: 0, band: 2, value: 1 });
  expect(renderer.inspect(7, 0)).toMatchObject({ column: 0, lane: 7, band: 2, value: 0 });
  expect(renderer.inspect(8, 0)).toMatchObject({ column: 1, lane: 0, band: 2, value: 0 });
  expect(renderer.inspect(15, 1)).toMatchObject({ column: 1, lane: 7, band: 1, value: 1 });
  history.accept(makeSnapshot(5, { frame: 350, ram: r => { r[0] = 0x40; r[1] = 0x02; } }), 0);
  renderer.update(); renderer.flush(Infinity);
  expect(levels(0)).toEqual([0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0]);
  expect(levels(2)).toEqual(steady);
  expect(levels(3)).toEqual(steady);
  expect(renderer.inspect(15, 1)?.band).toBe(2);
});
test.each(['activity', 'activity-bits', 'bytes', 'bits', 'xor', 'xor-bits', 'entropy', 'entropy-bits', 'activity-bytes', 'activity-bit-background'] as const)('incremental %s pixels match full composition after eviction and gaps', measurement => {
  const mode: AramMode = measurement === 'activity-bytes' ? 'activity' : measurement === 'activity-bit-background' ? 'activity-bits' : measurement;
  const history = new MemoryHistory(3); history.reset(1);
  const target = raster(), renderer = new WaterfallRenderer(target.canvas, history);
  const lanes = isBitMode(mode) ? 8 : 1;
  const options = { mode, columns: 8, window: { start: 0, span: 65536 }, height: 64, framesPerBand: 128, palette: 'grayscale' as const, activityByteBackground: measurement === 'activity-bytes' || measurement === 'activity-bit-background' };
  renderer.configure(options);
  for (let i = 0; i < 12; i++) {
    history.accept(makeSnapshot(i + 1, { frame: i * 256 + (i >= 8 ? 10000 : 0), ram: r => r.fill(i & 1 ? 255 : 0), activity: (r, w) => { (i & 1 ? r : w).fill(255); } }), 0);
    renderer.update(); renderer.flush(Infinity);
    const actual = target.pixels();
    for (let y = 0; y < options.height; y++) {
      const band = composeBand(history, renderer.cache, options, renderer.currentBand - y);
      for (let pixel = 0; pixel < options.columns * lanes; pixel++) {
        const x = Math.floor(pixel / lanes), lane = pixel % lanes;
        const value = band.row.values[lane * options.columns + x];
        const color = !band.row.valid ? [16, 23, 34, 255] : mode === 'activity' ? band.row.byteValues ? activityBytePalette(value, band.row.byteValues[x], 'grayscale') : activityPalette(value, 'grayscale') : mode === 'activity-bits' ? band.row.bitValues ? activityBitPalette(value, band.row.bitValues[lane * options.columns + x], 'grayscale') : activityPalette(value, 'grayscale') : mode === 'bytes' || mode === 'xor' ? bytePalette(value, 'grayscale') : mode === 'bits' || mode === 'xor-bits' ? [Math.round(value * 255), Math.round(value * 255), Math.round(value * 255), 255] : metricPalette(mode === 'entropy-bits' ? value : value / 8, 'grayscale');
        const offset = (y * options.columns * lanes + pixel) * 4;
        expect([...actual.subarray(offset, offset + 4)], `frame ${i}, y ${y}, pixel ${pixel}`).toEqual(color);
      }
    }
  }
});
