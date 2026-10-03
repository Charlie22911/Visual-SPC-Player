export type Rgba = [number, number, number, number];
export type PalettePreset = 'spectrum' | 'scope' | 'original' | 'grayscale' | 'accessible';

export const metricPalette = (value: number, preset: PalettePreset = 'spectrum'): Rgba => {
  const t = Math.max(0, Math.min(1, value));
  if (preset === 'grayscale') { const v = Math.round(t * 255); return [v, v, v, 255]; }
  const from = preset === 'accessible' ? [0, 32, 65] : [2, 7, 15];
  const to = preset === 'original' ? [255, 189, 72] : preset === 'accessible' ? [240, 228, 66] : [141, 255, 226];
  return [0, 1, 2].map(i => Math.round(from[i] + (to[i] - from[i]) * t)).concat(255) as Rgba;
};

const stops: Array<[number, [number, number, number]]> = [
  [0, [2, 4, 10]],
  [64, [24, 37, 112]],
  [128, [0, 119, 142]],
  [192, [72, 198, 142]],
  [255, [255, 209, 102]],
];

const makeByteColor = (value: number): Rgba => {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  if (clamped === 0) return [2, 4, 10, 255];
  let upper = 1;
  while (upper < stops.length - 1 && clamped > stops[upper][0]) upper += 1;
  const [fromValue, from] = stops[upper - 1];
  const [toValue, to] = stops[upper];
  const t = (clamped - fromValue) / (toValue - fromValue);
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
    255,
  ];
};

const byteColors = Array.from({ length: 256 }, (_, value) => makeByteColor(value));

const hslColor = (hue: number, saturation: number, lightness: number): Rgba => {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = ((hue % 360) + 360) % 360 / 60;
  const secondary = chroma * (1 - Math.abs(segment % 2 - 1));
  const [red, green, blue] =
    segment < 1 ? [chroma, secondary, 0] :
    segment < 2 ? [secondary, chroma, 0] :
    segment < 3 ? [0, chroma, secondary] :
    segment < 4 ? [0, secondary, chroma] :
    segment < 5 ? [secondary, 0, chroma] :
    [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return [
    clampChannel((red + offset) * 255),
    clampChannel((green + offset) * 255),
    clampChannel((blue + offset) * 255),
    255,
  ];
};

const spectrumColors = Array.from({ length: 256 }, (_, value): Rgba => {
  if (value === 0) return [2, 4, 10, 255];
  if (value === 255) return [255, 244, 220, 255];
  const hueGroup = value >>> 4;
  const intensity = value & 0x0f;
  const hue = hueGroup * 137.508;
  const lightness = 0.24 + intensity / 15 * 0.46;
  return hslColor(hue, 0.82, lightness);
});

export const bytePalette = (value: number, preset: PalettePreset = 'spectrum'): Rgba => {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  if (preset === 'spectrum') return spectrumColors[clamped];
  if (preset === 'grayscale') return [clamped, clamped, clamped, 255];
  if (preset === 'original') return [clamped, clampChannel(clamped * 0.78), clampChannel(clamped * 0.34), 255];
  if (preset === 'accessible') return [clampChannel(20 + clamped * 0.86), clampChannel(32 + clamped * 0.62), clampChannel(72 + clamped * 0.64), 255];
  return byteColors[clamped];
};

function clampChannel(value: number) { return Math.max(0, Math.min(255, Math.round(value))); }

const activity: Rgba[] = [
  [2, 5, 12, 255],
  [42, 168, 255, 255],
  [57, 222, 142, 255],
  [45, 231, 222, 255],
  [255, 190, 73, 255],
  [208, 116, 255, 255],
  [255, 105, 163, 255],
  [255, 244, 177, 255],
];

const accessibleActivity: Rgba[] = [
  [2, 5, 12, 255], [0, 114, 178, 255], [0, 158, 115, 255], [86, 180, 233, 255],
  [230, 159, 0, 255], [213, 94, 0, 255], [204, 121, 167, 255], [240, 228, 66, 255],
];

export const activityPalette = (kind: number, preset: PalettePreset = 'scope'): Rgba =>
  (preset === 'accessible' ? accessibleActivity : activity)[kind & 7];
// Darkened bytes remain visible beneath slightly translucent access colors.
export const activityBytePalette = (kind: number, value: number, preset: PalettePreset = 'spectrum'): Rgba => {
  const background = bytePalette(value, preset), foreground = activityPalette(kind, preset);
  return [0, 1, 2].map(i => Math.round(background[i] * 0.35 * (kind ? 0.08 : 1) + (kind ? foreground[i] * 0.92 : 0))).concat(255) as Rgba;
};

export const activityBitPalette = (kind: number, fraction: number, preset: PalettePreset = 'spectrum'): Rgba => {
  const off = bitPalette(false, preset), on = bitPalette(true, preset), foreground = activityPalette(kind, preset);
  const t = Math.max(0, Math.min(1, fraction));
  return [0, 1, 2].map(i => Math.round((off[i] + (on[i] - off[i]) * t) * 0.35 * (kind ? 0.08 : 1) + (kind ? foreground[i] * 0.92 : 0))).concat(255) as Rgba;
};
export const bitOff: Rgba = [2, 7, 15, 255];
export const bitOn: Rgba = [141, 255, 226, 255];
export const bitPalette = (on: boolean, preset: PalettePreset = 'scope'): Rgba => {
  if (preset === 'grayscale') return on ? [255, 255, 255, 255] : [0, 0, 0, 255];
  if (preset === 'original') return on ? [255, 189, 72, 255] : [9, 5, 2, 255];
  if (preset === 'accessible') return on ? [240, 228, 66, 255] : [0, 52, 89, 255];
  return on ? bitOn : bitOff;
};
