import { ARAM_BYTES } from '../audio/protocol';
import type { HistoryRecord } from './history';
import { isActivityMode, isBitMode, isEntropyMode, isXorMode, type AramMode } from './types';
import { columnRange, type AddressWindow } from './waterfallViewport';
export const POPCOUNT = Uint8Array.from({ length: 256 }, (_, n) => { let count = 0; for (; n; n &= n - 1) count++; return count; });
const countLogCount = Float64Array.from({ length: 257 }, (_, n) => n ? n * Math.log2(n) : 0);
export function blockEntropies(ram: Uint8Array, out: Float32Array): void {
  const counts = new Uint16Array(256);
  for (let block = 0; block < 256; block++) {
    counts.fill(0); let sum = 0;
    for (let a = block * 256; a < (block + 1) * 256; a++) {
      const v = ram[a], n = counts[v]; counts[v] = n + 1;
      sum += countLogCount[n + 1] - countLogCount[n];
    }
    out[block] = Math.max(0, Math.min(8, 8 - sum / 256));
  }
}
const binaryEntropy = Float32Array.from({ length: 257 }, (_, count) => {
  const p = count / 256;
  return count === 0 || count === 256 ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
});
export function blockBitEntropies(ram: Uint8Array, out: Float32Array): void {
  const counts = new Uint16Array(8);
  for (let block = 0; block < 256; block++) {
    counts.fill(0);
    for (let a = block * 256; a < (block + 1) * 256; a++) {
      const value = ram[a];
      for (let lane = 0; lane < 8; lane++) counts[lane] += (value >>> (7 - lane)) & 1;
    }
    for (let lane = 0; lane < 8; lane++) out[lane * 256 + block] = binaryEntropy[counts[lane]];
  }
}
export type ReducedRow = { lanes: 1 | 8; values: Float32Array; byteValues?: Float32Array; bitValues?: Float32Array; anyChange?: Uint8Array; valid: boolean };
export const createReducedRow = (mode: AramMode, columns: number, activityByteBackground = false): ReducedRow => ({
  lanes: isBitMode(mode) ? 8 : 1, values: new Float32Array(columns * (isBitMode(mode) ? 8 : 1)),
  anyChange: mode === 'xor' ? new Uint8Array(columns) : undefined, valid: true,
  byteValues: mode === 'activity' && activityByteBackground ? new Float32Array(columns) : undefined,
  bitValues: mode === 'activity-bits' && activityByteBackground ? new Float32Array(columns * 8) : undefined,
});
export function reduceRow(record: HistoryRecord, previous: HistoryRecord | null, mode: AramMode, window: AddressWindow, columns: number, out: ReducedRow, entropy?: Float32Array): void {
  out.values.fill(0); out.anyChange?.fill(0); out.byteValues?.fill(0); out.bitValues?.fill(0); out.valid = !isXorMode(mode) || previous !== null;
  if (!out.valid) return;
  if (isEntropyMode(mode) && !entropy) {
    entropy = new Float32Array(mode === 'entropy-bits' ? 2048 : 256);
    if (mode === 'entropy-bits') blockBitEntropies(record.payload, entropy); else blockEntropies(record.payload, entropy);
  }
  const data = record.payload;
  const activity = record.combinedActivity;
  for (let x = 0; x < columns; x++) {
    const [start, end] = columnRange(window, columns, x), count = end - start;
    if (isEntropyMode(mode)) {
      for (let a = start; a < end;) {
        const next = Math.min(end, ((a >>> 8) + 1) * 256);
        for (let lane = 0; lane < out.lanes; lane++) out.values[lane * columns + x] += entropy![lane * 256 + (a >>> 8)] * (next - a) / count;
        a = next;
      }
    } else {
      let sum = 0;
      for (let a = start; a < end; a++) {
        if (isActivityMode(mode)) {
          const i = a >>> 3, mask = 1 << (a & 7);
          sum |= (activity[i] & mask ? 1 : 0) | (activity[8192 + i] & mask ? 2 : 0) | (activity[16384 + i] & mask ? 4 : 0);
          if (out.byteValues) out.byteValues[x] += data[a];
          if (out.bitValues) for (let lane = 0; lane < 8; lane++) out.bitValues[lane * columns + x] += (data[a] >>> (7 - lane)) & 1;
        } else {
          const value = isXorMode(mode) ? data[a] ^ previous!.payload[a] : data[a];
          if (isBitMode(mode)) for (let lane = 0; lane < 8; lane++) { if (value & (0x80 >>> lane)) out.values[lane * columns + x]++; }
          else sum += value;
        }
      }
      if (isActivityMode(mode)) for (let lane = 0; lane < out.lanes; lane++) out.values[lane * columns + x] = sum;
      else if (isBitMode(mode)) for (let lane = 0; lane < 8; lane++) out.values[lane * columns + x] /= count;
      else out.values[x] = sum / count;
      if (out.byteValues) out.byteValues[x] /= count;
      if (out.bitValues) for (let lane = 0; lane < 8; lane++) out.bitValues[lane * columns + x] /= count;
      if (out.anyChange) out.anyChange[x] = sum > 0 ? 1 : 0;
    }
  }
}
