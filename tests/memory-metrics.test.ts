import { expect, test } from 'vitest';
import { POPCOUNT, blockEntropies, createReducedRow, reduceRow } from '../src/aram/metrics';
import { MemoryHistory } from '../src/aram/history';
import { makeSnapshot } from './helpers/snapshots';
test('popcounts and fixed entropy windows describe byte diversity', () => {
  expect([POPCOUNT[0], POPCOUNT[0x80], POPCOUNT[255]]).toEqual([0, 1, 8]);
  const out = new Float32Array(256);
  for (const [ram, expected] of [[new Uint8Array(65536), 0], [Uint8Array.from({ length: 65536 }, (_, i) => i & 1), 1], [Uint8Array.from({ length: 65536 }, (_, i) => i & 255), 8]] as const) { blockEntropies(ram, out); expect([...out].every(v => Math.abs(v - expected) < 1e-6)).toBe(true); }
});
test('XOR keeps isolated bits in buckets and unavailable baselines distinct', () => {
  const h = new MemoryHistory(3); h.reset(1);
  h.accept(makeSnapshot(1, { ram: r => { r[0] = 0x7f; } }), 0);
  h.accept(makeSnapshot(2, { ram: r => { r[0] = 0x80; r[65535] = 1; } }), 0);
  const row = createReducedRow('xor', 1024);
  reduceRow(h.latest()!, h.previous(h.latest()!), 'xor', { start: 0, span: 65536 }, 1024, row);
  expect(row.values[0]).toBe(255 / 64); expect(row.values[1023]).toBe(1 / 64); expect(row.anyChange![1023]).toBe(1);
  reduceRow(h.latest()!, null, 'xor', { start: 0, span: 65536 }, 1024, row); expect(row.valid).toBe(false);
});
test('bit order, activity kinds, and entropy weighting cross address boundaries', () => {
  const h = new MemoryHistory(2); h.reset(1);
  h.accept(makeSnapshot(1, { ram: r => { r[0] = 0x80; r[1] = 1; for (let i = 256; i < 512; i++) r[i] = i & 255; }, activity: (r, w) => { r[0] = 1; w[0] = 2; } }), 0);
  const rec = h.latest()!;
  const bits = createReducedRow('bits', 1); reduceRow(rec, null, 'bits', { start: 0, span: 2 }, 1, bits);
  expect(bits.values[0]).toBe(0.5); expect(bits.values[7]).toBe(0.5); expect(bits.values[1]).toBe(0);
  const activity = createReducedRow('activity', 1); reduceRow(rec, null, 'activity', { start: 0, span: 2 }, 1, activity); expect(activity.values[0]).toBe(3);
  const ent = createReducedRow('entropy', 1); reduceRow(rec, null, 'entropy', { start: 255, span: 2 }, 1, ent);
  const blocks = new Float32Array(256); blockEntropies(rec.payload.subarray(0, 65536), blocks); expect(ent.values[0]).toBeCloseTo((blocks[0] + blocks[1]) / 2);
});
