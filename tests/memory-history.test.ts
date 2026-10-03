import { expect, test } from 'vitest';
import { MemoryHistory } from '../src/aram/history';
import { ACTIVITY_BYTES, ARAM_BYTES, SNAPSHOT_BYTES } from '../src/audio/protocol';
import { makeSnapshot } from './helpers/snapshots';
import { composeBand, ReducedRowCache } from '../src/aram/waterfallRenderer';

test('default history retains every 240 Hz state across all time windows and recycles expired storage', () => {
  const h = new MemoryHistory(); h.reset(1);
  const input = makeSnapshot(0, { frame: 0 });
  const state = new DataView(input.payload, ARAM_BYTES + ACTIVITY_BYTES);
  const ram = new Uint8Array(input.payload, 0, ARAM_BYTES);
  const fill = (from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      input.sequence = i; input.audibleFrame = i * 32000 / 240;
      state.setFloat64(24, input.audibleFrame, true); ram[0] = i & 255;
      expect(h.accept(input, 0)).toBe(true);
    }
  };
  fill(0, 2880); // Twelve seconds, including two seconds already evicted.
  const records = [...h.records()];
  expect(records.length).toBeGreaterThanOrEqual(2401);
  expect(records.length).toBeLessThanOrEqual(2402);
  expect(records[0].audibleFrame).toBeLessThanOrEqual(64000);
  expect(records[1].audibleFrame).toBeGreaterThan(64000);
  for (let i = 1; i < records.length; i++) {
    expect(records[i].sequence).toBe(records[i - 1].sequence + 1);
    expect(records[i].payload[0]).toBe(records[i].sequence & 255);
    expect(h.previous(records[i])).toBe(records[i - 1]);
  }
  const cache = new ReducedRowCache(4096);
  for (const seconds of [2, 5, 10]) for (const mode of ['bytes', 'bits', 'activity', 'xor'] as const) {
    const framesPerBand = seconds * 32000 / 100;
    const newestBand = Math.floor(h.latest()!.audibleFrame / framesPerBand);
    for (let y = 1; y < 100; y++) {
      expect(composeBand(h, cache, { mode, window: { start: 0, span: 1 }, columns: 1, framesPerBand }, newestBand - y).row.valid).toBe(true);
    }
  }
  const allocated = h.payloadBytes;
  fill(2881, 5760);
  expect(h.count).toBeLessThanOrEqual(2402);
  expect(h.payloadBytes).toBeLessThanOrEqual(allocated + 2 * (SNAPSHOT_BYTES + ACTIVITY_BYTES));
  expect(h.get(records[0].id)).toBeNull();
  h.reset(2); expect(h.count).toBe(0); expect(h.payloadBytes).toBe(0);
});

test('time retention adjusts to rate changes without clearing history or inventing startup data', () => {
  const h = new MemoryHistory(); h.reset(1);
  let sequence = 0;
  for (let i = 0; i <= 600; i++) h.accept(makeSnapshot(sequence++, { frame: i * 32000 / 60 }), 0);
  const atChange = h.latest()!.id;
  for (let i = 1; i <= 1200; i++) h.accept(makeSnapshot(sequence++, { frame: 320000 + i * 32000 / 120 }), 0);
  expect(h.get(atChange)).not.toBeNull();
  expect(h.count).toBeGreaterThanOrEqual(1201);
  const peakBytes = h.payloadBytes;
  for (let i = 1; i <= 300; i++) h.accept(makeSnapshot(sequence++, { frame: 640000 + i * 32000 / 30 }), 0);
  expect(h.count).toBeGreaterThanOrEqual(301); expect(h.count).toBeLessThanOrEqual(302);
  expect(h.payloadBytes).toBeLessThan(peakBytes / 2);
  expect(h.previous(h.latest()!)).not.toBeNull();
  h.reset(1); h.accept(makeSnapshot(0, { frame: 0 }), 0);
  h.accept(makeSnapshot(1, { frame: 3200 }), 0);
  const cache = new ReducedRowCache();
  expect(composeBand(h, cache, { mode: 'bytes', window: { start: 0, span: 1 }, columns: 1, framesPerBand: 3200 }, -1).row.valid).toBe(false);
});
test('history owns data, wraps by ID, and preserves interval time after eviction', () => {
  const h = new MemoryHistory(3); h.reset(1);
  const input = makeSnapshot(1, { ram: r => { r[0] = 42; } }); h.accept(input, 0);
  const id = h.latest()!.id; new Uint8Array(input.payload)[0] = 99;
  expect(h.get(id)!.payload[0]).toBe(42);
  structuredClone(input.payload, { transfer: [input.payload] }); expect(h.get(id)!.payload[0]).toBe(42);
  for (let i = 2; i <= 4; i++) h.accept(makeSnapshot(i), 0);
  expect(h.count).toBe(3); expect(h.get(id)).toBeNull();
  const oldest = [...h.records()][0]; expect(oldest.intervalStartFrame).toBe(3200); expect(h.previous(oldest)).toBeNull();
  for (let i = 5; i <= 10000; i++) h.accept(makeSnapshot(i), 0);
  expect(h.payloadBytes).toBe(3 * (SNAPSHOT_BYTES + ACTIVITY_BYTES));
});
test('history owns both original activity and coalesced flags within its payload budget', () => {
  const h = new MemoryHistory(2); h.reset(1);
  const input = makeSnapshot(1, { activity: (_, w) => { w[0] = 1; } });
  input.combinedActivity = new Uint8Array(ACTIVITY_BYTES); input.combinedActivity[0] = 2;
  h.accept(input, 0); input.combinedActivity.fill(0); new Uint8Array(input.payload).fill(0);
  expect(h.latest()!.payload[ARAM_BYTES + 8192]).toBe(1);
  expect(h.latest()!.combinedActivity[0]).toBe(2);
  expect(h.payloadBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
});
test('ordering, pause, native duplicates, and generation boundaries', () => {
  const h = new MemoryHistory(3); h.reset(1);
  expect(h.accept(makeSnapshot(1), 0)).toBe(true);
  expect(h.accept(makeSnapshot(1), 0)).toBe(false);
  expect(h.accept(makeSnapshot(2, { generation: 2 }), 0)).toBe(false);
  expect(h.accept(makeSnapshot(2, { frame: 3200 }), 0)).toBe(false); expect(h.count).toBe(1);
  expect(h.accept(makeSnapshot(3, { frame: 6400, nativeFrame: 3200 }), 0)).toBe(true);
  expect(h.previous(h.latest()!)!.sequence).toBe(1);
  const old = h.latest()!.id; h.reset(2); h.accept(makeSnapshot(1, { generation: 2 }), 0);
  expect(h.latest()!.id).toBeGreaterThan(old); expect(h.previous(h.latest()!)).toBeNull(); expect(h.get(old)).toBeNull();
});
test('rate changes and gaps preserve older history and invalidate only the new baseline', () => {
  const h = new MemoryHistory(10); h.reset(1); h.accept(makeSnapshot(1), 0);
  h.accept(makeSnapshot(2, { requestId: 2 }), 0); expect(h.count).toBe(2); expect(h.latest()!.continuous).toBe(false);
  h.accept(makeSnapshot(3, { requestId: 2, frame: 14400 }), 0); expect(h.latest()!.continuous).toBe(true); // Exactly 250 ms.
  h.accept(makeSnapshot(4, { requestId: 2, frame: 22401 }), 0); expect(h.latest()!.continuous).toBe(false);
  h.accept(makeSnapshot(5, { requestId: 2, frame: 22500 }), 1); expect(h.latest()!.continuous).toBe(false);
  h.accept(makeSnapshot(6, { requestId: 2, frame: 22600 }), 1); expect(h.latest()!.continuous).toBe(true);
  h.accept(makeSnapshot(7, { requestId: 2, frame: 0 }), 1); expect(h.count).toBe(1); expect(h.latest()!.continuous).toBe(false);
});
