import { expect, test } from 'vitest';
import { ARAM_MEASUREMENTS, renderingMode } from '../src/aram/types';
import { blockBitEntropies, createReducedRow, reduceRow } from '../src/aram/metrics';
import { MemoryHistory } from '../src/aram/history';
import { composeBand, ReducedRowCache } from '../src/aram/waterfallRenderer';
import { defaultSettings, parseSettingsFile, serializeSettingsFile } from '../src/settings';
import { makeSnapshot } from './helpers/snapshots';

test('Data combines byte/bit rendering and XOR independently of the selected measurement', () => {
  expect(ARAM_MEASUREMENTS).toEqual(['activity', 'data', 'entropy']);
  expect(renderingMode({ mode: 'data', dataUnit: 'byte', dataXor: false, entropyUnit: 'byte' })).toBe('bytes');
  expect(renderingMode({ mode: 'data', dataUnit: 'bit', dataXor: false, entropyUnit: 'byte' })).toBe('bits');
  expect(renderingMode({ mode: 'data', dataUnit: 'byte', dataXor: true, entropyUnit: 'byte' })).toBe('xor');
  expect(renderingMode({ mode: 'data', dataUnit: 'bit', dataXor: true, entropyUnit: 'byte' })).toBe('xor-bits');
  expect(renderingMode({ mode: 'entropy', dataUnit: 'byte', dataXor: true, entropyUnit: 'bit' })).toBe('entropy-bits');
});

test('new portable settings preserve Data and Entropy controls and migrate legacy modes', () => {
  const settings = { ...defaultSettings, mode: 'data' as const, dataUnit: 'bit' as const, dataXor: true, entropyUnit: 'bit' as const };
  expect(JSON.parse(serializeSettingsFile(settings)).version).toBe(3);
  expect(parseSettingsFile(serializeSettingsFile(settings))).toEqual(settings);
  for (const [mode, unit, xor] of [['bytes', 'byte', false], ['bits', 'bit', false], ['xor', 'byte', true]] as const) {
    expect(parseSettingsFile(JSON.stringify({ format: 'visual-spc-player-settings', version: 2, settings: { ...defaultSettings, mode } }))).toMatchObject({ mode: 'data', dataUnit: unit, dataXor: xor, entropyUnit: 'byte' });
  }
});

test('XOR byte values and bit lanes represent the actual flipped-bit mask', () => {
  const h = new MemoryHistory(3); h.reset(1);
  h.accept(makeSnapshot(1, { ram: r => { r[0] = 0x80; } }), 0);
  h.accept(makeSnapshot(2, { ram: r => { r[0] = 0x8f; } }), 0);
  const byte = createReducedRow('xor', 1);
  reduceRow(h.latest()!, h.previous(h.latest()!), 'xor', { start: 0, span: 1 }, 1, byte);
  expect(byte.values[0]).toBe(15);
  const bits = createReducedRow('xor-bits', 1);
  reduceRow(h.latest()!, h.previous(h.latest()!), 'xor-bits', { start: 0, span: 1 }, 1, bits);
  expect([...bits.values]).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  reduceRow(h.latest()!, null, 'xor-bits', { start: 0, span: 1 }, 1, bits);
  expect(bits.valid).toBe(false);
});

test('Waterfall ORs flipped masks per address before reducing byte buckets or bit lanes', () => {
  const h = new MemoryHistory(3); h.reset(1);
  h.accept(makeSnapshot(1, { frame: 0 }), 0);
  h.accept(makeSnapshot(2, { frame: 100, ram: r => { r[0] = 8; } }), 0);
  h.accept(makeSnapshot(3, { frame: 200, ram: r => { r[0] = 9; r[1] = 2; } }), 0);
  const opts = { window: { start: 0, span: 2 }, columns: 1, framesPerBand: 200 };
  const cache = new ReducedRowCache();
  expect(composeBand(h, cache, { ...opts, mode: 'xor' }, 0).row.values[0]).toBe((9 + 2) / 2);
  expect([...composeBand(h, cache, { ...opts, mode: 'xor-bits' }, 0).row.values]).toEqual([0, 0, 0, 0, 0.5, 0, 0.5, 0.5]);
});

test('per-bit entropy distinguishes fixed positions from balanced positions within byte blocks', () => {
  const ram = Uint8Array.from({ length: 65536 }, (_, a) => a & 1);
  const out = new Float32Array(8 * 256); blockBitEntropies(ram, out);
  expect(out[0]).toBe(0); expect(out[7 * 256]).toBe(1);
  ram.fill(255); blockBitEntropies(ram, out); expect([...out].every(v => v === 0)).toBe(true);
  for (let a = 0; a < ram.length; a++) ram[a] = a & 255;
  blockBitEntropies(ram, out); expect([...out].every(v => v === 1)).toBe(true);
});
