import { expect, test } from 'vitest';
import { ActivityHistory, renderAram, type ActivityMaps } from '../src/aram/renderer';
import { MemoryHistory } from '../src/aram/history';
import { composeBand, ReducedRowCache } from '../src/aram/waterfallRenderer';
import { makeSnapshot } from './helpers/snapshots';
import { defaultSettings, loadStoredSettings, parseSettingsFile, saveStoredSettings, serializeSettingsFile } from '../src/settings';

const tile = (pixels: Uint8ClampedArray, address: number) => {
  const top = (address >>> 8) * 2048 + (address & 255) * 4;
  return Array.from({ length: 8 }, (_, lane) => [...pixels.subarray(((lane < 4 ? top : top + 1024) + (lane & 3)) * 4, ((lane < 4 ? top : top + 1024) + (lane & 3)) * 4 + 4)]);
};
test('Activity Bit Map repeats address accesses over all eight bits and pairs each background bit with that interval', () => {
  const ram = new Uint8Array(65536); ram[0] = 0x80; ram[1] = 1;
  const maps: ActivityMaps = { read: new Uint8Array(8192), write: new Uint8Array(8192), execute: new Uint8Array(8192) }; maps.read[0] = 1;
  const trail = new ActivityHistory(2000);
  const plain = renderAram('activity-bits', ram, trail, maps, 1, 'grayscale');
  expect([plain.width, plain.height]).toEqual([1024, 512]);
  expect(tile(plain.pixels, 0)).toEqual(Array.from({ length: 8 }, () => [42, 168, 255, 255]));
  const paired = renderAram('activity-bits', ram, trail, maps, 2, 'grayscale', undefined, { activityByteBackground: true });
  expect(tile(paired.pixels, 0)).toEqual([[46, 162, 242, 255], ...Array.from({ length: 7 }, () => [39, 155, 235, 255])]);
  expect(tile(paired.pixels, 1)).toEqual([...Array.from({ length: 7 }, () => [0, 0, 0, 255]), [89, 89, 89, 255]]);
  maps.read.fill(0); ram[0] = 1;
  const ending = renderAram('activity-bits', ram, trail, maps, 3, 'grayscale', undefined, { activityByteBackground: true });
  expect(tile(ending.pixels, 0)).toEqual([...Array.from({ length: 7 }, () => [0, 0, 0, 255]), [89, 89, 89, 255]]);
});

test('Activity Bit Waterfall unions all accesses and keeps ending bit occupancy in every time band', () => {
  const history = new MemoryHistory(5); history.reset(1);
  history.accept(makeSnapshot(1, { frame: 0 }), 0);
  history.accept(makeSnapshot(2, { frame: 50, ram: r => { r[0] = 0x80; }, activity: r => { r[0] = 1; } }), 0);
  history.accept(makeSnapshot(3, { frame: 150, ram: r => { r[1] = 1; }, activity: (_r, w) => { w[0] = 2; } }), 0);
  const options = { mode: 'activity-bits' as const, columns: 1, window: { start: 0, span: 2 }, framesPerBand: 200, activityByteBackground: true };
  const cache = new ReducedRowCache();
  const row = composeBand(history, cache, options, 0).row;
  expect([...row.values]).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
  expect([...row.bitValues!]).toEqual([0, 0, 0, 0, 0, 0, 0, .5]);
  expect([...composeBand(history, cache, { ...options, activityByteBackground: false }, 0).row.values]).toEqual([...row.values]);
  history.accept(makeSnapshot(4, { frame: 250, ram: r => { r[0] = 0x80; r[1] = 0x80; } }), 0);
  const ending = composeBand(history, cache, options, 1).row;
  expect([...ending.values]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  expect([...ending.bitValues!]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
});

test('Activity representation survives saved settings and defaults to Byte in older exports', () => {
  const settings = { ...defaultSettings, activityUnit: 'bit' as const, activityByteBackground: true };
  expect(saveStoredSettings(settings).ok).toBe(true);
  expect(loadStoredSettings().settings.activityUnit).toBe('bit');
  expect(parseSettingsFile(serializeSettingsFile(settings))).toEqual(settings);
  const older = JSON.parse(serializeSettingsFile(settings)); delete older.settings.activityUnit;
  expect(parseSettingsFile(JSON.stringify(older))).toMatchObject({ activityUnit: 'byte', activityByteBackground: true });
  older.settings.activityUnit = 'invalid'; expect(() => parseSettingsFile(JSON.stringify(older))).toThrow('invalid value');
  localStorage.clear();
});
