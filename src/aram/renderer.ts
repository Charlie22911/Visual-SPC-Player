import { activityBytePalette, activityBitPalette, activityPalette, bitPalette, bytePalette, metricPalette, type PalettePreset, type Rgba } from './palettes';

import { isBitMode, isXorMode, isEntropyMode, type AramMode } from './types';
export type { AramMode } from './types';

export type ActivityMaps = {
  read: Uint8Array;
  write: Uint8Array;
  execute: Uint8Array;
};

export type PixelBuffer = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
};

type RenderTables = {
  activity: Uint32Array;
  activityBytes: Uint32Array;
  activityBits: Uint32Array;
  bytes: Uint32Array;
  bits: Uint32Array;
  xor: Uint32Array;
  entropy: Uint32Array;
};

const tablesByPalette = new Map<PalettePreset, RenderTables>();
const renderTables = (preset: PalettePreset) => {
  const cached = tablesByPalette.get(preset);
  if (cached) return cached;

  // Pack through an RGBA byte view so the word stores use the host's byte
  // order. Uint8ClampedArray also preserves the original blend rounding.
  const rgba = new Uint8ClampedArray(4);
  const word = new Uint32Array(rgba.buffer);
  const pack = (color: Rgba, overlay?: Rgba) => {
    rgba[0] = overlay ? color[0] * 0.55 + overlay[0] * 0.45 : color[0];
    rgba[1] = overlay ? color[1] * 0.55 + overlay[1] * 0.45 : color[1];
    rgba[2] = overlay ? color[2] * 0.55 + overlay[2] * 0.45 : color[2];
    rgba[3] = color[3];
    return word[0];
  };
  const tables: RenderTables = {
    activity: new Uint32Array(8),
    activityBytes: new Uint32Array(8 * 256),
    activityBits: new Uint32Array(8 * 256 * 8),
    bytes: new Uint32Array(8 * 256),
    bits: new Uint32Array(8 * 256 * 8),
    xor: new Uint32Array(256),
    entropy: new Uint32Array(256),
  };
  for (let i = 0; i < 256; i++) tables.xor[i] = pack(bytePalette(i, preset));
  for (let i = 0; i < 256; i++) tables.entropy[i] = pack(metricPalette(i / 255, preset));
  const off = bitPalette(false, preset);
  const on = bitPalette(true, preset);
  for (let kind = 0; kind < 8; kind += 1) {
    const activityColor = activityPalette(kind, preset);
    const overlay = kind ? activityColor : undefined;
    tables.activity[kind] = pack(activityColor);
    const offPixel = pack(off, overlay);
    const onPixel = pack(on, overlay);
    const activityOff = pack(activityBitPalette(kind, 0, preset));
    const activityOn = pack(activityBitPalette(kind, 1, preset));
    for (let value = 0; value < 256; value += 1) {
      const index = kind * 256 + value;
      tables.activityBytes[index] = pack(activityBytePalette(kind, value, preset));
      tables.bytes[index] = pack(bytePalette(value, preset), overlay);
      for (let slot = 0; slot < 8; slot += 1) {
        tables.bits[index * 8 + slot] = (value & (0x80 >>> slot)) ? onPixel : offPixel;
        tables.activityBits[index * 8 + slot] = (value & (0x80 >>> slot)) ? activityOn : activityOff;
      }
    }
  }
  tablesByPalette.set(preset, tables);
  return tables;
};

const mapBit = (map: Uint8Array, address: number) =>
  (map[address >>> 3] & (1 << (address & 7))) !== 0;

const activityKind = (maps: ActivityMaps, address: number) =>
  (mapBit(maps.read, address) ? 1 : 0) |
  (mapBit(maps.write, address) ? 2 : 0) |
  (mapBit(maps.execute, address) ? 4 : 0);

export class ActivityHistory {
  private readonly kinds = new Uint8Array(65536);
  private readonly seenAt = new Float64Array(65536);

  constructor(readonly decayMilliseconds = 100) {}

  clear() {
    this.kinds.fill(0);
    this.seenAt.fill(0);
  }

  apply(maps: ActivityMaps, now: number) {
    for (let address = 0; address < 65536; address += 1) {
      const kind = activityKind(maps, address);
      if (kind !== 0) {
        this.kinds[address] = kind;
        this.seenAt[address] = now;
      }
    }
  }

  kindAt(address: number, now: number) {
    return now - this.seenAt[address] <= this.decayMilliseconds ? this.kinds[address] : 0;
  }
}

export const renderAram = (
  mode: AramMode,
  ram: Uint8Array,
  history: ActivityHistory | null,
  activity: ActivityMaps | null,
  now: number,
  palette: PalettePreset = 'spectrum',
  target?: Uint8ClampedArray<ArrayBuffer>,
  metrics?: { xor?: Uint8Array; xorValid?: boolean; entropy?: Float32Array; activityByteBackground?: boolean },
): PixelBuffer => {
  if (ram.length < 65536) throw new RangeError('ARAM payload is truncated');
  if (history && activity && !isXorMode(mode) && !isEntropyMode(mode)) history.apply(activity, now);
  const tables = renderTables(palette);
  const width = isBitMode(mode) ? 1024 : 256;
  const height = isBitMode(mode) ? 512 : 256;
  const length = width * height * 4;
  const pixels = target?.length === length ? target : new Uint8ClampedArray(length);
  // ImageData is aligned; retain support for callers supplying a byte subview.
  const words = pixels.byteOffset % 4 === 0
    ? new Uint32Array(pixels.buffer, pixels.byteOffset, length / 4)
    : new Uint32Array(length / 4);
  if (mode === 'xor' || mode === 'entropy') {
    for (let address = 0; address < 65536; address++) {
      words[address] = mode === 'xor'
        ? metrics?.xorValid && metrics.xor ? tables.xor[metrics.xor[address]] : tables.entropy[(address & 8) ? 20 : 35]
        : tables.entropy[Math.max(0, Math.min(255, Math.round((metrics?.entropy?.[address >>> 8] ?? 0) / 8 * 255)))];
    }
  } else if (isBitMode(mode)) {
    for (let address = 0; address < 65536; address += 1) {
      const paired = mode === 'activity-bits' && metrics?.activityByteBackground;
      const kind = mode === 'activity-bits'
        ? history && !paired ? history.kindAt(address, now) : activity ? activityKind(activity, address) : 0
        : mode === 'bits' && history ? history.kindAt(address, now) : 0;
      const tile = (kind * 256 + (mode === 'xor-bits' ? metrics?.xor?.[address] ?? 0 : ram[address])) * 8;
      const top = (address >>> 8) * 2048 + (address & 255) * 4;
      const bottom = top + 1024;
      if (mode === 'activity-bits' && !paired) {
        for (let lane = 0; lane < 8; lane++) words[(lane < 4 ? top : bottom) + (lane & 3)] = tables.activity[kind];
        continue;
      }
      if (mode === 'entropy-bits' || (mode === 'xor-bits' && !metrics?.xorValid)) {
        for (let lane = 0; lane < 8; lane++) {
          const value = mode === 'entropy-bits' ? Math.max(0, Math.min(255, Math.round((metrics?.entropy?.[lane * 256 + (address >>> 8)] ?? 0) * 255))) : (address & 8) ? 20 : 35;
          words[(lane < 4 ? top : bottom) + (lane & 3)] = tables.entropy[value];
        }
        continue;
      }
      // Copy the precomputed 4 x 2 tile, MSB first. No per-bit palette lookup,
      // coordinate division, channel clamping, or blending in the frame loop.
      const bitColors = paired ? tables.activityBits : tables.bits;
      words[top] = bitColors[tile];
      words[top + 1] = bitColors[tile + 1];
      words[top + 2] = bitColors[tile + 2];
      words[top + 3] = bitColors[tile + 3];
      words[bottom] = bitColors[tile + 4];
      words[bottom + 1] = bitColors[tile + 5];
      words[bottom + 2] = bitColors[tile + 6];
      words[bottom + 3] = bitColors[tile + 7];
    }
  } else if (mode === 'activity') {
    const paired = metrics?.activityByteBackground;
    for (let address = 0; address < 65536; address += 1) {
      const kind = history && !paired
        ? history.kindAt(address, now)
        : activity ? activityKind(activity, address) : 0;
      words[address] = paired ? tables.activityBytes[kind * 256 + ram[address]] : tables.activity[kind];
    }
  } else {
    for (let address = 0; address < 65536; address += 1) {
      const kind = history ? history.kindAt(address, now) : 0;
      words[address] = tables.bytes[kind * 256 + ram[address]];
    }
  }
  if (words.buffer !== pixels.buffer) pixels.set(new Uint8Array(words.buffer));
  return { width, height, pixels };
};
