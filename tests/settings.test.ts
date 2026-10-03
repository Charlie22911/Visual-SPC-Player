import { afterEach, expect, test, vi } from 'vitest';
import { defaultSettings, loadStoredSettings, parseSettingsFile, saveStoredSettings, serializeSettingsFile } from '../src/settings';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
const legacy = { mode: 'bits', visualizerRate: 60, palette: 'grayscale', activityPersistence: false, activityPersistenceMilliseconds: 100, volume: 0.8 };
test('portable settings use the current format and still import earlier exports', () => {
  const exported = JSON.parse(serializeSettingsFile(defaultSettings));
  expect(exported.format).toBe('visual-spc-player-settings');
  expect(parseSettingsFile(JSON.stringify({ ...exported, format: 'spc-memory-scope-settings' }))).toEqual(defaultSettings);
});

test('new view settings default to Map and five seconds', () => {
  expect(defaultSettings).toMatchObject({ geometry: 'map', waterfallSeconds: 5 });
  expect(parseSettingsFile(JSON.stringify({ format: 'visual-spc-player-settings', version: 1, settings: legacy }))).toMatchObject({ ...legacy, mode: 'data', dataUnit: 'bit', dataXor: false, geometry: 'map', waterfallSeconds: 5 });
});
test('activity background survives explicit storage and portable settings; older files default off', () => {
  expect(defaultSettings.activityByteBackground).toBe(false);
  const settings = { ...defaultSettings, activityByteBackground: true };
  expect(parseSettingsFile(serializeSettingsFile(settings))).toEqual(settings);
  expect(saveStoredSettings(settings).ok).toBe(true);
  expect(loadStoredSettings().settings.activityByteBackground).toBe(true);
  const older = { ...settings } as Partial<typeof settings>; delete older.activityByteBackground;
  expect(parseSettingsFile(JSON.stringify({ format: 'visual-spc-player-settings', version: 2, settings: older })).activityByteBackground).toBe(false);
  expect(() => parseSettingsFile(JSON.stringify({ format: 'visual-spc-player-settings', version: 2, settings: { ...settings, activityByteBackground: 'yes' } }))).toThrow();
});

test('byte diagnostic is opt-in, saved, exported, and defaults off in older settings', () => {
  expect(defaultSettings.byteRefreshDiagnostic).toBe(false);
  const settings = { ...defaultSettings, byteRefreshDiagnostic: true };
  expect(saveStoredSettings(settings).ok).toBe(true);
  expect(loadStoredSettings().settings.byteRefreshDiagnostic).toBe(true);
  expect(parseSettingsFile(serializeSettingsFile(settings))).toEqual(settings);
  const older = { ...settings } as Partial<typeof settings>; delete older.byteRefreshDiagnostic;
  expect(parseSettingsFile(JSON.stringify({ format: 'visual-spc-player-settings', version: 2, settings: older })).byteRefreshDiagnostic).toBe(false);
  expect(() => parseSettingsFile(JSON.stringify({ format: 'visual-spc-player-settings', version: 2, settings: { ...settings, byteRefreshDiagnostic: 'on' } }))).toThrow();
});
test.each(['activity', 'data', 'entropy'])('version 3 round trips %s', (mode) => {
  const settings = { ...defaultSettings, mode, geometry: 'waterfall', waterfallSeconds: 10 } as typeof defaultSettings;
  expect(JSON.parse(serializeSettingsFile(settings)).version).toBe(3);
  expect(parseSettingsFile(serializeSettingsFile(settings))).toEqual(settings);
});
test.each([{ geometry: 'invalid' }, { waterfallSeconds: 3 }, { activityPersistenceMilliseconds: Infinity }])('rejects invalid version 2 settings %j', (change) => {
  expect(() => parseSettingsFile(JSON.stringify({ format: 'visual-spc-player-settings', version: 2, settings: { ...defaultSettings, ...change } }))).toThrow();
});
test('stored settings validate fields separately and saving stays explicit', () => {
  localStorage.setItem('spc-geometry', 'waterfall'); localStorage.setItem('spc-waterfall-seconds', '10'); localStorage.setItem('spc-mode', 'xor');
  expect(loadStoredSettings().settings).toMatchObject({ geometry: 'waterfall', waterfallSeconds: 10, mode: 'data', dataXor: true, dataUnit: 'byte' });
  localStorage.setItem('spc-waterfall-seconds', 'garbage');
  expect(loadStoredSettings().settings.waterfallSeconds).toBe(5);
  expect(saveStoredSettings(defaultSettings).ok).toBe(true);
  expect(localStorage.getItem('spc-geometry')).toBe('map');
});
test('storage failure preserves defaults and provides a warning', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(loadStoredSettings()).toEqual({ settings: { ...defaultSettings }, warning: expect.any(String) });
});

test('stored Data and Entropy choices round trip, and legacy modes take precedence over stale new keys', () => {
  const settings = { ...defaultSettings, mode: 'data' as const, dataUnit: 'bit' as const, dataXor: true, entropyUnit: 'bit' as const };
  saveStoredSettings(settings);
  expect(loadStoredSettings().settings).toEqual(settings);
  localStorage.setItem('spc-mode', 'bytes');
  expect(loadStoredSettings().settings).toMatchObject({ mode: 'data', dataUnit: 'byte', dataXor: false });
  localStorage.setItem('spc-mode', 'data'); localStorage.setItem('spc-data-unit', 'invalid');
  expect(loadStoredSettings().settings).toMatchObject({ dataUnit: 'byte', dataXor: true, entropyUnit: 'bit' });
});

test.each([{ dataUnit: 'bits' }, { dataXor: 'on' }, { entropyUnit: 'bytes' }, { entropyUnit: undefined }])('rejects invalid version 3 representation values %j', change => {
  expect(() => parseSettingsFile(JSON.stringify({ format: 'visual-spc-player-settings', version: 3, settings: { ...defaultSettings, ...change } }))).toThrow('invalid value');
});
