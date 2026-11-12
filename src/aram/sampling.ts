import type { MemorySampling } from './types';

export type NumericCell = { value: number; background: number; kind: number; held: number; changed: boolean; valid: boolean };
export type NumericSource = (x: number, y: number) => NumericCell;
const missing = (): NumericCell => ({ value: 0, background: 0, kind: 0, held: 0, changed: false, valid: false });

// Coordinates are source-cell edges. Values and bit coverage stay linear until
// the final palette lookup; access masks are unions, never averaged colors.
export function sampleNumeric(source: NumericSource, width: number, height: number, cx: number, cy: number, sx: number, sy: number, sampling: MemorySampling): NumericCell & { coverage: number } {
  const outside = cx < 0 || cy < 0 || cx >= width || cy >= height;
  if (outside && (sampling !== 'area' || cx + sx / 2 <= 0 || cy + sy / 2 <= 0 || cx - sx / 2 >= width || cy - sy / 2 >= height)) return { ...missing(), coverage: 0 };
  const anchor = source(Math.max(0, Math.min(width - 1, Math.floor(cx))), Math.max(0, Math.min(height - 1, Math.floor(cy))));
  if (sampling === 'nearest') return { ...anchor, coverage: anchor.valid ? 1 : 0 };
  // A missing time interval cannot be filled by its valid neighbors.
  if (!anchor.valid) return { ...missing(), coverage: 0 };
  const smooth = sampling === 'smooth';
  const lx = smooth ? Math.floor(cx - .5) : cx - sx / 2;
  const ly = smooth ? Math.floor(cy - .5) : cy - sy / 2;
  const hx = smooth ? lx + 2 : cx + sx / 2;
  const hy = smooth ? ly + 2 : cy + sy / 2;
  let weight = 0, totalWeight = 0;
  const result = missing();
  for (let y = Math.floor(ly); y < Math.ceil(hy); y++) for (let x = Math.floor(lx); x < Math.ceil(hx); x++) {
    const w = smooth ? Math.max(0, 1 - Math.abs(cx - .5 - x)) * Math.max(0, 1 - Math.abs(cy - .5 - y)) : Math.max(0, Math.min(hx, x + 1) - Math.max(lx, x)) * Math.max(0, Math.min(hy, y + 1) - Math.max(ly, y));
    if (!w) continue;
    totalWeight += w;
    // Clamp smooth taps at the outer image edge, as a clamped texture would.
    const px = smooth ? Math.max(0, Math.min(width - 1, x)) : x, py = smooth ? Math.max(0, Math.min(height - 1, y)) : y;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const cell = source(px, py); if (!cell.valid) continue;
    weight += w; result.value += cell.value * w; result.background += cell.background * w;
    result.kind |= cell.kind; result.held |= cell.held; result.changed ||= cell.changed;
  }
  if (weight) { result.value /= weight; result.background /= weight; result.valid = true; }
  return { ...result, coverage: totalWeight ? weight / totalWeight : 0 };
}

export function temporalSample(source: NumericSource, x: number, y: number, height: number, radius: number, activity: boolean): NumericCell {
  const result = { ...source(x, y) }; if (!result.valid || radius < 1) return result;
  const step = Math.max(1, Math.ceil(radius / 8));
  let sum = (activity ? result.background : result.value) * 2, norm = 2;
  for (let age = 1; age <= radius && y + age < height; age++) {
    const older = source(x, y + age); if (!older.valid) break;
    if (age % step) continue;
    const weight = 2 * (radius + step - age) / (radius + step);
    sum += (activity ? older.background : older.value) * weight; norm += weight;
  }
  if (activity) result.background = sum / norm; else result.value = sum / norm;
  return result;
}
