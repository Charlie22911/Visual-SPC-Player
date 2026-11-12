import type { SpectrumSettings } from './types';
export type { SpectrumSettings } from './types';

export const defaultSpectrumSettings: SpectrumSettings = {
  preset: 'balanced', fftSize: 2048, hopSize: 256, sampling: 'smooth', seconds: 5,
  logarithmic: true, temporal: true, temporalMs: 25, difference: false,
  palette: 'green', floorDb: -90, ceilingDb: 0,
};
const finiteRange = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const member = <T>(value: unknown, values: readonly T[], fallback: T): T => values.includes(value as T) ? value as T : fallback;

export function normalizeSpectrumSettings(value: unknown): SpectrumSettings {
  const d = defaultSpectrumSettings;
  const v = (value && typeof value === 'object' ? value : {}) as Partial<SpectrumSettings>;
  return {
    preset: member(v.preset, ['balanced', 'transient', 'frequency', 'raw', 'custom'], d.preset),
    fftSize: member(v.fftSize, [1024, 2048, 4096], d.fftSize),
    hopSize: member(v.hopSize, [64, 128, 256, 512], d.hopSize),
    sampling: member(v.sampling, ['nearest', 'smooth', 'area'], d.sampling),
    seconds: member(v.seconds, [2, 5, 10], d.seconds),
    logarithmic: typeof v.logarithmic === 'boolean' ? v.logarithmic : d.logarithmic,
    temporal: typeof v.temporal === 'boolean' ? v.temporal : d.temporal,
    temporalMs: Math.round(finiteRange(v.temporalMs, d.temporalMs, 0, 200)),
    difference: typeof v.difference === 'boolean' ? v.difference : d.difference,
    palette: member(v.palette, ['green', 'heat', 'grayscale'], d.palette),
    floorDb: finiteRange(v.floorDb, d.floorDb, -120, -30),
    ceilingDb: finiteRange(v.ceilingDb, d.ceilingDb, -30, 0),
  };
}

export function applySpectrumPreset(preset: SpectrumSettings['preset'], current: SpectrumSettings): SpectrumSettings {
  if (preset === 'custom') return { ...current, preset };
  const temporal = preset === 'balanced' || preset === 'frequency';
  return { ...current, preset, fftSize: preset === 'transient' ? 1024 : preset === 'frequency' ? 4096 : 2048,
    hopSize: preset === 'transient' ? 64 : 256, sampling: preset === 'raw' ? 'nearest' : 'smooth',
    temporal, temporalMs: temporal ? 25 : 0 };
}
