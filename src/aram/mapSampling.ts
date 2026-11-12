import { activityPalette, activityBitPalette, activityBytePalette, bitPalette, bytePalette, metricPalette, type PalettePreset, type Rgba } from './palettes';
import { sampleNumeric, type NumericSource } from './sampling';
import { isActivityMode, isBitMode, isEntropyMode, isXorMode, type AramMode, type MemorySampling } from './types';
import type { Viewport } from './viewport';

export function numericMapSource(mode: AramMode, ram: Uint8Array, access: Uint8Array, held: Uint8Array, entropy: Float32Array): NumericSource {
  const bits = isBitMode(mode);
  return (x, y) => {
    const a = bits ? (y >>> 1) * 256 + (x >>> 2) : y * 256 + x, lane = bits ? (y & 1) * 4 + (x & 3) : 0;
    const value = isEntropyMode(mode) ? entropy[lane * 256 + (a >>> 8)] : bits ? (ram[a] >>> (7 - lane)) & 1 : ram[a];
    const i = a >>> 3, mask = 1 << (a & 7);
    return { value, background: value, kind: (access[i] & mask ? 1 : 0) | (access[8192 + i] & mask ? 2 : 0) | (access[16384 + i] & mask ? 4 : 0), held: held[a], changed: value !== 0, valid: true };
  };
}

export function summarizeMapFootprint(source: NumericSource, bits: boolean, lx: number, ly: number, hx: number, hy: number) {
  lx = Math.max(0, lx); ly = Math.max(0, ly); hx = Math.min(bits ? 1024 : 256, hx); hy = Math.min(bits ? 512 : 256, hy);
  let value = 0, weight = 0, cells = 0, kind = 0, held = 0, changed = false;
  const addresses = new Set<number>();
  for (let y = Math.floor(ly); y < Math.ceil(hy); y++) for (let x = Math.floor(lx); x < Math.ceil(hx); x++) {
    const w = Math.max(0, Math.min(hx, x + 1) - Math.max(lx, x)) * Math.max(0, Math.min(hy, y + 1) - Math.max(ly, y));
    if (!w) continue;
    const cell = source(x, y); value += cell.value * w; weight += w; kind |= cell.kind; held |= cell.held; changed ||= cell.changed; cells++;
    addresses.add(bits ? (y >>> 1) * 256 + (x >>> 2) : y * 256 + x);
  }
  let first = 65536, last = -1; for (const a of addresses) { first = Math.min(first, a); last = Math.max(last, a); }
  return { value: weight ? value / weight : 0, cells, bytes: addresses.size, first, last, kind, held, changed };
}

// Fallback for systems without WebGL 2. It uses the same measurement-space
// sampling as the shader, at the destination's physical pixel resolution.
export function renderSampledMap(image: ImageData, source: NumericSource, mode: AramMode, palette: PalettePreset, sampling: MemorySampling, viewport: Viewport, underlay: boolean, previousValid: boolean, persistence: boolean) {
  const bits = isBitMode(mode), width = bits ? 1024 : 256, height = bits ? 512 : 256;
  const off = bitPalette(false, palette), on = bitPalette(true, palette);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const cell = sampleNumeric(source, width, height, (x + .5 - viewport.offsetX) / viewport.scale, (y + .5 - viewport.offsetY) / viewport.scale, 1 / viewport.scale, 1 / viewport.scale, sampling);
    let color: Rgba = [2, 5, 12, 255];
    if (cell.valid) {
      if (isActivityMode(mode)) {
        const kind = persistence && !underlay ? cell.held : cell.kind;
        color = underlay ? bits ? activityBitPalette(kind, cell.value, palette) : activityBytePalette(kind, cell.value, palette) : activityPalette(kind, palette);
      } else if (isEntropyMode(mode)) color = metricPalette(cell.value / (bits ? 1 : 8), palette);
      else if (isXorMode(mode) && !previousValid) color = metricPalette(((x & 8) ? 20 : 35) / 255, palette);
      else {
        let value = cell.value * (bits ? 255 : 1);
        if ((isXorMode(mode) && cell.changed) || (bits && value > 0)) value = Math.max(1, value);
        color = bits ? [0, 1, 2].map(i => Math.round(off[i] + (on[i] - off[i]) * Math.min(255, Math.round(value)) / 255)).concat(255) as Rgba : bytePalette(value, palette);
        if (persistence && !isXorMode(mode) && cell.held) { const overlay = activityPalette(cell.held, palette); color = [0, 1, 2].map(i => color[i] * .55 + overlay[i] * .45).concat(255) as Rgba; }
      }
    }
    const offset = (y * image.width + x) * 4;
    image.data[offset] = 2 + (color[0] - 2) * cell.coverage; image.data[offset + 1] = 5 + (color[1] - 5) * cell.coverage; image.data[offset + 2] = 12 + (color[2] - 12) * cell.coverage; image.data[offset + 3] = 255;
  }
}
