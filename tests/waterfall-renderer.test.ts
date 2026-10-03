import { expect, test } from 'vitest';
import { MemoryHistory } from '../src/aram/history';
import { composeBand, intervalBands, ReducedRowCache } from '../src/aram/waterfallRenderer';
import { makeSnapshot } from './helpers/snapshots';
const options = { window: { start: 0, span: 65536 }, columns: 1024, framesPerBand: 6400 };
test('interval boundaries do not add a false sample after an exact endpoint', () => {
  expect(intervalBands(0, 100, 100)).toEqual([0, 0]);
  expect(intervalBands(100, 200, 100)).toEqual([1, 1]);
  expect(intervalBands(50, 250, 100)).toEqual([0, 2]);
});
test('activity background retains all accesses in a time band and uses bytes at that band\'s end', () => {
  const history = new MemoryHistory(3); history.reset(1);
  history.accept(makeSnapshot(1, { frame: 0 }), 0);
  history.accept(makeSnapshot(2, { frame: 100, ram: r => r.fill(25), activity: r => r.fill(255) }), 0);
  history.accept(makeSnapshot(3, { frame: 200, ram: r => { r[0] = 100; r[1] = 200; }, activity: (_, w) => { w[0] = 2; } }), 0);
  const cache = new ReducedRowCache(1000);
  const opt = { ...options, window: { start: 0, span: 2 }, columns: 1, mode: 'activity' as const, activityByteBackground: true };
  const paired = composeBand(history, cache, opt, 0);
  expect(paired.row.values[0]).toBe(3);
  expect(paired.row.byteValues![0]).toBe(150);
  expect(paired.recordId).toBe(history.latest()!.id);
  expect(composeBand(history, cache, { ...opt, activityByteBackground: false }, 0).row.values[0]).toBe(3);
  // Updating a partial band changes ending bytes while preserving its accesses.
  history.accept(makeSnapshot(4, { frame: 300, ram: r => r.fill(255) }), 0);
  const next = composeBand(history, cache, opt, 0);
  expect(next.row.values[0]).toBe(3); expect(next.row.byteValues![0]).toBe(255);
  history.accept(makeSnapshot(5, { frame: 400, ram: r => r.fill(200) }), 0);
  // The read sample was evicted; its contribution disappears in both views.
  expect(composeBand(history, cache, { ...opt, activityByteBackground: false }, 0).row.values[0]).toBe(2);
  expect(cache.bytes).toBeLessThanOrEqual(cache.budget);
});
test('coalesced echo sweeps have the same complete address coverage with or without underlaid bytes', () => {
  const history = new MemoryHistory(4); history.reset(1);
  history.accept(makeSnapshot(1, { frame: 0 }), 0);
  const next = makeSnapshot(2, { frame: 640, ram: r => r.fill(255), activity: (r, w) => { r[32] = 0xf0; w[32] = 0xf0; } });
  next.combinedActivity = new Uint8Array(24576);
  next.combinedActivity[32] = 255; next.combinedActivity[8192 + 32] = 255;
  history.accept(next, 0);
  const cache = new ReducedRowCache(1024);
  const opt = { window: { start: 256, span: 8 }, columns: 8, framesPerBand: 320, mode: 'activity' as const };
  for (const band of [0, 1]) {
    const plain = composeBand(history, cache, opt, band);
    const background = composeBand(history, cache, { ...opt, activityByteBackground: true }, band);
    expect([...background.row.values]).toEqual([...plain.row.values]);
    expect([...background.row.values]).toEqual(Array(8).fill(3));
    expect([...background.row.byteValues!]).toEqual(Array(8).fill(255));
  }
  // No persistence into the following time band, despite unchanged ending RAM.
  history.accept(makeSnapshot(3, { frame: 960, ram: r => r.fill(255) }), 0);
  const cleared = composeBand(history, cache, { ...opt, activityByteBackground: true }, 2);
  expect(cleared.row.valid).toBe(true); expect([...cleared.row.values]).toEqual(Array(8).fill(0));
  expect([...cleared.row.byteValues!]).toEqual(Array(8).fill(255));
});
test('temporal reduction ORs activity and preserves returning XOR transitions', () => {
  const h = new MemoryHistory(10); h.reset(1);
  h.accept(makeSnapshot(1, { frame: 0 }), 0);
  h.accept(makeSnapshot(2, { frame: 3200, ram: r => { r[0] = 1; }, activity: r => { r[0] = 1; } }), 0);
  h.accept(makeSnapshot(3, { frame: 6400, activity: (_, w) => { w[0] = 1; } }), 0);
  const cache = new ReducedRowCache(8192);
  const activity = composeBand(h, cache, { ...options, mode: 'activity' }, 0);
  expect(activity.row.values[0]).toBe(3);
  const xor = composeBand(h, cache, { ...options, mode: 'xor' }, 0);
  expect(xor.row.values[0]).toBe(1 / 64); expect(xor.row.anyChange![0]).toBe(1);
  const bytes = composeBand(h, cache, { ...options, mode: 'bytes' }, 0); expect(bytes.row.values[0]).toBe(0);
});
test.each([30, 60, 144])('time geometry follows playback at %i Hz', hz => {
  const h = new MemoryHistory(400); h.reset(1); h.accept(makeSnapshot(1, { frame: 0 }), 0);
  for (let i = 1; i <= hz; i++) h.accept(makeSnapshot(i + 1, { frame: i * 32000 / hz }), 0);
  const cache = new ReducedRowCache(2048);
  expect(composeBand(h, cache, { ...options, columns: 1, mode: 'bytes', framesPerBand: 3200 }, 9).row.valid).toBe(true);
  expect(composeBand(h, cache, { ...options, columns: 1, mode: 'bytes', framesPerBand: 3200 }, 10).row.valid).toBe(false);
});
test('gaps remain unavailable, cache bytes stay bounded, and eviction invalidates old XOR', () => {
  const h = new MemoryHistory(2); h.reset(1); const cache = new ReducedRowCache(20000);
  h.accept(makeSnapshot(1, { frame: 0 }), 0); h.accept(makeSnapshot(2, { frame: 3200 }), 0);
  const oldest = h.latest()!; expect(cache.row(h, oldest, 'xor', options.window, 1024).valid).toBe(true);
  h.accept(makeSnapshot(3, { frame: 16000 }), 0);
  expect(cache.row(h, oldest, 'xor', options.window, 1024).valid).toBe(false);
  expect(composeBand(h, cache, { ...options, mode: 'bytes', framesPerBand: 3200 }, 2).row.valid).toBe(false);
  for (let i = 0; i < 50; i++) cache.row(h, h.latest()!, 'bits', { start: i, span: 1024 }, 1024);
  expect(cache.bytes).toBeLessThanOrEqual(20000);
});
