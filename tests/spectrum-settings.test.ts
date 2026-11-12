import { expect, test } from 'vitest';
import { applySpectrumPreset, defaultSpectrumSettings, normalizeSpectrumSettings } from '../src/spectrum/settings';

test('spectrum presets match native analysis and display defaults', () => {
  expect(defaultSpectrumSettings.fftSize).toBe(2048);
  expect(applySpectrumPreset('transient', defaultSpectrumSettings)).toMatchObject({ fftSize: 1024, hopSize: 64, temporal: false });
  expect(applySpectrumPreset('frequency', defaultSpectrumSettings)).toMatchObject({ fftSize: 4096, hopSize: 256, temporal: true });
  expect(applySpectrumPreset('raw', defaultSpectrumSettings)).toMatchObject({ fftSize: 2048, hopSize: 256, sampling: 'nearest', temporal: false });
  expect(applySpectrumPreset('balanced', { ...defaultSpectrumSettings, difference: true, seconds: 10 })).toMatchObject({ difference: true, seconds: 10 });
});

test('corrupt persisted spectrum settings cannot produce unsupported analysis or invalid display ranges', () => {
  expect(normalizeSpectrumSettings(null)).toEqual(defaultSpectrumSettings);
  const settings = normalizeSpectrumSettings({ fftSize: 128, hopSize: 0, floorDb: Number.NaN, ceilingDb: 70, temporalMs: -5, seconds: 900, sampling: 'bad' });
  expect(settings).toMatchObject({ fftSize: 2048, hopSize: 256, floorDb: -90, ceilingDb: 0, temporalMs: 0, seconds: 5, sampling: 'smooth' });
  expect(normalizeSpectrumSettings({ floorDb: -2, ceilingDb: -99 })).toMatchObject({ floorDb: -30, ceilingDb: -30 });
});
