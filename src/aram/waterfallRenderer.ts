import type { HistoryRecord, MemoryHistory } from './history';
import { blockEntropies, blockBitEntropies, createReducedRow, reduceRow, type ReducedRow } from './metrics';
import { activityBytePalette, activityBitPalette, activityPalette, bitPalette, bytePalette, metricPalette, type PalettePreset, type Rgba } from './palettes';
import { isActivityMode, isBitMode, isEntropyMode, isXorMode, type AramMode } from './types';
import type { AddressWindow } from './waterfallViewport';
import { NumericGpu } from './numericGpu';
import { temporalSample, type NumericSource } from './sampling';
import type { MemorySampling } from './types';

export const intervalBands = (start: number, end: number, size: number): [number, number] => [Math.floor(start / size), Math.ceil(end / size) - 1];
type CacheEntry = { row?: ReducedRow; entropy?: Float32Array; bytes: number };
export class ReducedRowCache {
  private entries = new Map<string, CacheEntry>();
  bytes = 0;
  constructor(readonly budget = 16 * 1024 * 1024) {}
  clear() { this.entries.clear(); this.bytes = 0; }
  private read(key: string) {
    const value = this.entries.get(key);
    if (value) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  private save(key: string, value: CacheEntry) {
    if (value.bytes > this.budget) return;
    while (this.bytes + value.bytes > this.budget && this.entries.size) {
      const oldest = this.entries.keys().next().value!; this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
    this.entries.set(key, value); this.bytes += value.bytes;
  }
  row(history: MemoryHistory, record: HistoryRecord, mode: AramMode, window: AddressWindow, columns: number, activityByteBackground = false) {
    const previous = history.previous(record);
    const paired = isActivityMode(mode) && activityByteBackground;
    const key = `${record.id}/${previous?.id ?? 0}/${mode}/${window.start}/${window.span}/${columns}/${paired}`;
    const hit = this.read(key); if (hit?.row) return hit.row;
    let entropy: Float32Array | undefined;
    if (isEntropyMode(mode)) {
      const entropyKey = `entropy/${mode}/${record.id}`; entropy = this.read(entropyKey)?.entropy;
      if (!entropy) {
        entropy = new Float32Array(mode === 'entropy-bits' ? 2048 : 256);
        if (mode === 'entropy-bits') blockBitEntropies(record.payload, entropy); else blockEntropies(record.payload, entropy);
        this.save(entropyKey, { entropy, bytes: entropy.byteLength });
      }
    }
    const row = createReducedRow(mode, columns, paired); reduceRow(record, previous, mode, window, columns, row, entropy);
    this.save(key, { row, bytes: row.values.byteLength + (row.anyChange?.byteLength ?? 0) + (row.byteValues?.byteLength ?? 0) + (row.bitValues?.byteLength ?? 0) });
    return row;
  }
}
export type BandOptions = { mode: AramMode; window: AddressWindow; columns: number; framesPerBand: number; activityByteBackground?: boolean };
export type ComposedBand = { row: ReducedRow; recordId: number | null; startFrame: number; endFrame: number };
export function composeBand(history: MemoryHistory, cache: ReducedRowCache, options: BandOptions, band: number): ComposedBand {
  const row = createReducedRow(options.mode, options.columns, options.activityByteBackground); row.valid = false;
  const startFrame = band * options.framesPerBand, endFrame = startFrame + options.framesPerBand;
  let recordId: number | null = null;
  // Combine masks before address reduction: ORing bucket averages would lose
  // both bit positions and changes that return to their original byte value.
  const xorMask = isXorMode(options.mode) ? new Uint8Array(65536) : null;
  let xorRecord: HistoryRecord | null = null;
  for (const record of history.records()) {
    if (record.intervalStartFrame === null || record.audibleFrame <= startFrame || record.intervalStartFrame >= endFrame) continue;
    recordId = record.id;
    if (xorMask) {
      const previous = history.previous(record);
      if (!previous) continue;
      xorRecord = record;
      for (let a = options.window.start; a < options.window.start + options.window.span; a++) xorMask[a] |= record.payload[a] ^ previous.payload[a];
      continue;
    }
    const source = cache.row(history, record, options.mode, options.window, options.columns, options.activityByteBackground);
    if (!source.valid) continue;
    row.valid = true;
    if (isActivityMode(options.mode)) {
      for (let x = 0; x < row.values.length; x++) row.values[x] |= source.values[x];
      // Accesses cover the whole displayed band. Bytes describe its ending
      // state, including writes from every coalesced audio callback in it.
      row.byteValues?.set(source.byteValues!);
      row.bitValues?.set(source.bitValues!);
    }
    else row.values.set(source.values);
  }
  if (xorMask && xorRecord) reduceRow({ ...xorRecord, payload: xorMask }, null, options.mode === 'xor-bits' ? 'bits' : 'bytes', options.window, options.columns, row);
  return { row, recordId, startFrame, endFrame };
}

const unavailableColor: Rgba = [16, 23, 34, 255];
const colorTables = new Map<PalettePreset, { bytes: Rgba[]; bits: Rgba[]; metrics: Rgba[]; activityBytes: Rgba[]; activityBits: Rgba[] }>();
function colors(palette: PalettePreset) {
  let table = colorTables.get(palette);
  if (!table) {
    const off = bitPalette(false, palette), on = bitPalette(true, palette);
    table = {
      bytes: Array.from({ length: 256 }, (_, i) => bytePalette(i, palette)),
      bits: Array.from({ length: 256 }, (_, n) => [0, 1, 2].map(i => Math.round(off[i] + (on[i] - off[i]) * n / 255)).concat(255) as Rgba),
      metrics: Array.from({ length: 256 }, (_, i) => metricPalette(i / 255, palette)),
      activityBytes: Array.from({ length: 2048 }, (_, i) => activityBytePalette(i >>> 8, i & 255, palette)),
      activityBits: Array.from({ length: 2048 }, (_, i) => activityBitPalette(i >>> 8, (i & 255) / 255, palette)),
    };
    colorTables.set(palette, table);
  }
  return table;
}
function rowColor(row: ReducedRow, mode: AramMode, x: number, palette: PalettePreset): Rgba {
  if (!row.valid) return unavailableColor;
  const value = row.values[x];
  if (mode === 'activity') return row.byteValues ? colors(palette).activityBytes[value * 256 + Math.round(row.byteValues[x])] : activityPalette(value, palette);
  if (mode === 'activity-bits') return row.bitValues ? colors(palette).activityBits[value * 256 + Math.round(row.bitValues[x] * 255)] : activityPalette(value, palette);
  const table = colors(palette);
  if (mode === 'bytes' || mode === 'xor') return table.bytes[mode === 'xor' && row.anyChange![x] ? Math.max(1, Math.round(value)) : Math.round(value)];
  if (mode === 'bits' || mode === 'xor-bits') return table.bits[value > 0 ? Math.max(1, Math.round(value * 255)) : 0];
  const t = mode === 'entropy-bits' ? value : value / 8;
  return table.metrics[Math.max(0, Math.min(255, Math.round(t * 255)))];
}

export type WaterfallOptions = BandOptions & { height: number; palette: PalettePreset; sampling?: MemorySampling; temporal?: boolean; temporalMs?: number };
// Live views use a physical-pixel numeric ring texture. The Canvas path remains
// incremental and is also used when WebGL 2 is unavailable.
export class WaterfallRenderer {
  readonly cache = new ReducedRowCache();
  private options: WaterfallOptions | null = null;
  private newestBand = -1;
  private pending = new Set<number>();
  private epochGeneration = -1;
  private oldestId = -1;
  private image: ImageData | null = null;
  private readonly gpu: NumericGpu | null;
  private slots = new Float64Array(0);
  private presentationPending = false;
  constructor(readonly canvas: HTMLCanvasElement, private readonly history: MemoryHistory, useGpu = false) {
    this.gpu = useGpu ? NumericGpu.create(canvas, true) : null;
    // Once WebGL has claimed a canvas, a later initialization failure cannot
    // turn it into a 2D canvas. Keep the fallback on fresh offscreen storage.
    if (useGpu && !this.gpu && !canvas.getContext('2d')) this.canvas = canvas.ownerDocument.createElement('canvas');
  }
  get accelerated() { return this.gpu !== null; }
  get currentBand() { return this.newestBand; }
  get pendingCount() { return this.pending.size + (this.presentationPending ? 1 : 0); }
  get pendingRows() { return this.pending.size; }
  get config() { return this.options; }
  configure(options: WaterfallOptions) {
    if (JSON.stringify(this.options) === JSON.stringify(options)) return;
    const prior = this.options;
    const presentationOnly = prior && prior.mode === options.mode && prior.columns === options.columns && prior.height === options.height && prior.framesPerBand === options.framesPerBand && prior.window.start === options.window.start && prior.window.span === options.window.span && prior.activityByteBackground === options.activityByteBackground;
    this.options = options; this.canvas.width = options.columns * (isBitMode(options.mode) ? 8 : 1); this.canvas.height = options.height;
    if (presentationOnly && this.gpu) { this.present(); return; }
    if (this.gpu) { this.gpu.configureRows(this.canvas.width, options.height); this.slots = new Float64Array(options.height); this.slots.fill(NaN); }
    this.image = null; this.newestBand = -1; this.pending.clear();
  }
  update() {
    const options = this.options, latest = this.history.latest();
    const context = this.gpu ? null : this.canvas.getContext('2d'); if (!options || (!context && !this.gpu)) return;
    if (!latest) {
      this.cache.clear(); this.newestBand = -1; this.oldestId = -1; this.pending.clear();
      if (this.gpu) { this.gpu.clearRows(); this.present(); }
      else if (context) { context.fillStyle = '#101722'; context.fillRect(0, 0, this.canvas.width, options.height); }
      return;
    }
    if (this.epochGeneration !== latest.generation) { this.cache.clear(); this.newestBand = -1; this.pending.clear(); this.epochGeneration = latest.generation; this.gpu?.clearRows(); this.slots.fill(NaN); }
    const nextBand = Math.floor(latest.audibleFrame / options.framesPerBand);
    const bands = options.height, width = this.canvas.width;
    const delta = nextBand - this.newestBand, shift = delta;
    if (this.newestBand < 0 || delta < 0 || shift >= options.height) {
      context?.clearRect(0, 0, width, options.height); this.gpu?.clearRows(); this.slots.fill(NaN); this.pending.clear();
      for (let k = nextBand; k > nextBand - bands; k--) this.pending.add(k);
    } else if (shift > 0) {
      context?.drawImage(this.canvas, 0, 0, width, options.height - shift, 0, shift, width, options.height - shift);
      context?.clearRect(0, 0, width, shift);
      for (let k = nextBand; k > this.newestBand; k--) this.pending.add(k);
    }
    this.newestBand = nextBand;
    if (latest.intervalStartFrame !== null) {
      const [from, to] = intervalBands(latest.intervalStartFrame, latest.audibleFrame, options.framesPerBand);
      for (let k = Math.max(from, nextBand - bands + 1); k <= Math.min(to, nextBand); k++) this.pending.add(k);
    } else this.pending.add(nextBand);
    const oldest = this.history.records()[Symbol.iterator]().next().value as HistoryRecord | undefined;
    const oldestBand = oldest ? Math.floor((oldest.intervalStartFrame ?? oldest.audibleFrame) / options.framesPerBand) : nextBand;
    if (oldest && (oldest.id !== this.oldestId || isXorMode(options.mode))) {
      const [from, to] = oldest.intervalStartFrame !== null ? intervalBands(oldest.intervalStartFrame, oldest.audibleFrame, options.framesPerBand) : [oldestBand, oldestBand];
      for (let k = Math.max(from, nextBand - bands + 1); k <= Math.min(to, nextBand); k++) this.pending.add(k);
      this.oldestId = oldest.id;
    }
    const unavailableY = Math.max(0, Math.min(options.height, nextBand - oldestBand + 1));
    if (context) { context.fillStyle = '#101722'; context.fillRect(0, unavailableY, width, options.height - unavailableY); }
    for (const k of this.pending) if (k > nextBand || k <= nextBand - bands || k < oldestBand) this.pending.delete(k);
    if (!this.gpu && options.temporal) {
      const radius = Math.max(1, Math.round(Math.max(10, Math.min(200, options.temporalMs ?? 50)) * 32 / options.framesPerBand));
      // An evicted or revised older band also changes the causal window of
      // newer pixels. The GPU reads these dependencies directly from its ring.
      for (const k of [...this.pending]) for (let age = 1; age <= radius && k + age <= nextBand; age++) this.pending.add(k + age);
    }
    if (this.gpu) {
      for (let slot = 0; slot < this.slots.length; slot++) if (this.slots[slot] < oldestBand) { this.gpu.invalidateRow(this.slots[slot]); this.slots[slot] = NaN; }
      for (const k of this.pending) { const slot = ((k % bands) + bands) % bands; if (this.slots[slot] !== k) { this.gpu.invalidateRow(k); this.slots[slot] = k; } }
    }
  }
  flush(budgetMs = 4, present = true) {
    const options = this.options, context = this.gpu ? null : this.canvas.getContext('2d'); if (!options || (!context && !this.gpu)) return;
    const started = performance.now(), lanes = isBitMode(options.mode) ? 8 : 1;
    if (!this.image && context) this.image = context.createImageData(options.columns * lanes, 1);
    const dirty = [...this.pending].sort((a, b) => b - a);
    const radius = options.temporal ? Math.max(1, Math.round(Math.max(10, Math.min(200, options.temporalMs ?? 50)) * 32 / options.framesPerBand)) : 0;
    const rows = new Map<number, ReducedRow>();
    const source: NumericSource = (x, y) => {
      const k = this.newestBand - y;
      let row = rows.get(k); if (!row) { row = composeBand(this.history, this.cache, options, k).row; rows.set(k, row); }
      const column = Math.floor(x / lanes), index = (x % lanes) * options.columns + column;
      return { value: row.values[index], background: row.byteValues?.[column] ?? row.bitValues?.[index] ?? 0, kind: isActivityMode(options.mode) ? row.values[index] : 0, held: 0, changed: !!row.anyChange?.[column], valid: row.valid };
    };
    for (const k of dirty) {
      const band = composeBand(this.history, this.cache, options, k);
      if (this.gpu) { this.gpu.uploadRow(k, band.row, options.columns); this.presentationPending = true; this.pending.delete(k); if (performance.now() - started >= budgetMs) break; continue; }
      const data = this.image!.data;
      if (radius && band.row.valid) {
        // Smooth measurements/underlays causally, preserving this band's exact
        // access mask. The reduced history remains unfiltered for inspection.
        for (let lane = 0; lane < lanes; lane++) for (let x = 0; x < options.columns; x++) {
          const index = lane * options.columns + x, cell = temporalSample(source, x * lanes + lane, this.newestBand - k, options.height, radius, isActivityMode(options.mode));
          if (isActivityMode(options.mode)) { if (band.row.byteValues) band.row.byteValues[x] = cell.background; if (band.row.bitValues) band.row.bitValues[index] = cell.background; }
          else band.row.values[index] = cell.value;
        }
      }
      for (let lane = 0; lane < lanes; lane++) for (let x = 0; x < options.columns; x++) {
        // Bit planes stay lane-major in the reduction cache. Interleave them
        // horizontally here so every canvas row describes one time band.
        const offset = (x * lanes + lane) * 4;
        const color = rowColor(band.row, options.mode, lane * options.columns + x, options.palette);
        data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = 255;
      }
      context!.putImageData(this.image!, 0, this.newestBand - k); this.pending.delete(k);
      if (performance.now() - started >= budgetMs) break;
    }
    if (present) this.present();
  }
  present() { if (this.gpu && this.options) this.gpu.draw(this.options, this.canvas.width, this.canvas.height, this.newestBand); this.presentationPending = false; }
  dispose() { this.gpu?.dispose(); }
  inspect(pixel: number, y: number) {
    if (!this.options) return null;
    const lanes = isBitMode(this.options.mode) ? 8 : 1;
    const column = Math.floor(pixel / lanes), lane = Math.floor(pixel) % lanes;
    const band = this.newestBand - Math.floor(y);
    const composed = composeBand(this.history, this.cache, this.options, band);
    return { ...composed, band, lane, column, value: composed.row.values[lane * this.options.columns + column], byteValue: composed.row.byteValues?.[column] };
  }
}
