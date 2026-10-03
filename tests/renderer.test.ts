import { describe, expect, test } from 'vitest';
import { ActivityHistory, renderAram, type ActivityMaps } from '../src/aram/renderer';
import { activityPalette, bytePalette } from '../src/aram/palettes';
import { metricPalette } from '../src/aram/palettes';

const pixel = (rgba: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(rgba.subarray((y * width + x) * 4, (y * width + x + 1) * 4));

describe('ARAM rendering', () => {
  test('activity byte background darkens bytes and uses only the paired sample despite persistence', () => {
    const ram = new Uint8Array(65536);
    const maps: ActivityMaps = { read: new Uint8Array(8192), write: new Uint8Array(8192), execute: new Uint8Array(8192) };
    const trail = new ActivityHistory(2000);
    maps.read[0] = 1;
    renderAram('activity', ram, trail, maps, 0);
    maps.read[0] = 0; maps.write[0] = 2; ram[0] = 255; ram[1] = 128;
    const image = renderAram('activity', ram, trail, maps, 1, 'grayscale', undefined, { activityByteBackground: true });
    expect(pixel(image.pixels, 256, 0, 0)).toEqual([89, 89, 89, 255]);
    const write = activityPalette(2);
    expect(pixel(image.pixels, 256, 1, 0)).toEqual(write.map((channel, i) => i === 3 ? 255 : Math.round(channel * 0.92 + 128 * 0.35 * 0.08)));
    maps.write[0] = 0; ram[1] = 255;
    renderAram('activity', ram, trail, maps, 2, 'grayscale', image.pixels, { activityByteBackground: true });
    expect(pixel(image.pixels, 256, 1, 0)).toEqual([89, 89, 89, 255]);
  });
  test('scalar modes distinguish unavailable XOR and render exact metrics', () => {
    const ram = new Uint8Array(65536), xor = new Uint8Array(65536), entropy = new Float32Array(256);
    xor[1] = 255; entropy[1] = 8;
    const x = renderAram('xor', ram, null, null, 0, 'grayscale', undefined, { xor, xorValid: true });
    expect(pixel(x.pixels, 256, 0, 0)).toEqual(metricPalette(0, 'grayscale'));
    expect(pixel(x.pixels, 256, 1, 0)).toEqual(metricPalette(1, 'grayscale'));
    const unavailable = renderAram('xor', ram, null, null, 0, 'grayscale', undefined, { xorValid: false });
    expect(pixel(unavailable.pixels, 256, 0, 0)).not.toEqual(pixel(x.pixels, 256, 0, 0));
    const e = renderAram('entropy', ram, null, null, 0, 'grayscale', undefined, { entropy });
    expect(pixel(e.pixels, 256, 255, 0)).toEqual(metricPalette(0, 'grayscale'));
    expect(pixel(e.pixels, 256, 0, 1)).toEqual(metricPalette(1, 'grayscale'));
  });
  test('metric grayscale intensity is monotonic', () => {
    let last = -1; for (let i = 0; i <= 255; i++) { const value = metricPalette(i / 255, 'grayscale')[0]; expect(value).toBeGreaterThanOrEqual(last); last = value; }
  });
  test('renders exact byte palette endpoints', () => {
    const ram = new Uint8Array(65536);
    ram[0] = 0;
    ram[1] = 255;
    const image = renderAram('bytes', ram, null, null, 0);
    expect(pixel(image.pixels, image.width, 0, 0)).toEqual(bytePalette(0));
    expect(pixel(image.pixels, image.width, 1, 0)).toEqual(bytePalette(255));
  });

  test.each([
    [0x80, [0, 0]],
    [0x01, [3, 1]],
  ])('renders value %# in only its expected bit pixel', (value, expected) => {
    const ram = new Uint8Array(65536);
    ram[0] = value;
    const image = renderAram('bits', ram, null, null, 0);
    const lit: number[][] = [];
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if (pixel(image.pixels, image.width, x, y)[0] > 80) lit.push([x, y]);
      }
    }
    expect(lit).toEqual([expected]);
  });

  test('decodes activity map byte boundaries and expires by elapsed time', () => {
    const maps: ActivityMaps = {
      read: new Uint8Array(8192),
      write: new Uint8Array(8192),
      execute: new Uint8Array(8192),
    };
    for (const address of [0x0000, 0x0007, 0x0008, 0x00ff, 0x0100, 0xffff]) {
      maps.read[address >>> 3] |= 1 << (address & 7);
    }
    maps.write[0x0100 >>> 3] |= 1 << (0x0100 & 7);
    maps.execute[0xffff >>> 3] |= 1 << (0xffff & 7);

    const history = new ActivityHistory(100);
    history.apply(maps, 1000);
    expect(history.kindAt(0x0008, 1050)).toBe(1);
    expect(history.kindAt(0x0100, 1050)).toBe(3);
    expect(history.kindAt(0xffff, 1050)).toBe(5);
    expect(history.kindAt(0x0008, 1101)).toBe(0);
  });

  test.each(['activity', 'bytes', 'bits'] as const)('updates the reused %s image on consecutive display frames', (mode) => {
    const ram = new Uint8Array(65536);
    const maps: ActivityMaps = {
      read: new Uint8Array(8192), write: new Uint8Array(8192), execute: new Uint8Array(8192),
    };
    const first = renderAram(mode, ram, null, maps, 0, 'grayscale');
    for (let frame = 1; frame <= 12; frame += 1) {
      const on = frame % 2 === 1;
      ram[256] = on ? 255 : 0;
      maps.read[32] = on ? 1 : 0;
      const next = renderAram(mode, ram, null, maps, frame * 1000 / 240, 'grayscale', first.pixels);
      expect(next.pixels).toBe(first.pixels);
      const expected = mode === 'activity'
        ? on ? [42, 168, 255, 255] : [2, 5, 12, 255]
        : on ? [255, 255, 255, 255] : [0, 0, 0, 255];
      expect(pixel(next.pixels, next.width, 0, mode === 'bits' ? 2 : 1)).toEqual(expected);
    }
  });

  test('preserves bit order across tile, row, and final-address boundaries', () => {
    const ram = new Uint8Array(65536);
    ram[255] = 0x81;
    ram[256] = 0x42;
    ram[65535] = 0x18;
    const image = renderAram('bits', ram, null, null, 0, 'grayscale');
    for (const [x, y] of [[1020, 0], [1023, 1], [1, 2], [2, 3], [1023, 510], [1020, 511]]) {
      expect(pixel(image.pixels, image.width, x, y)).toEqual([255, 255, 255, 255]);
    }
    for (const [x, y] of [[1021, 0], [0, 2], [3, 3], [1021, 511]]) {
      expect(pixel(image.pixels, image.width, x, y)).toEqual([0, 0, 0, 255]);
    }
  });

  test.each(['bytes', 'bits'] as const)('keeps %s values live during persistence and removes the expired overlay', (mode) => {
    const ram = new Uint8Array(65536);
    const maps: ActivityMaps = {
      read: new Uint8Array(8192), write: new Uint8Array(8192), execute: new Uint8Array(8192),
    };
    maps.read[0] = 1;
    const history = new ActivityHistory(100);
    const image = renderAram(mode, ram, history, maps, 0, 'grayscale');
    expect(pixel(image.pixels, image.width, 0, 0)).toEqual([19, 76, 115, 255]);
    maps.read.fill(0);
    ram[0] = 255;
    renderAram(mode, ram, history, maps, 4, 'grayscale', image.pixels);
    expect(pixel(image.pixels, image.width, 0, 0)).toEqual([159, 216, 255, 255]);
    renderAram(mode, ram, history, maps, 101, 'grayscale', image.pixels);
    expect(pixel(image.pixels, image.width, 0, 0)).toEqual([255, 255, 255, 255]);
  });
});
