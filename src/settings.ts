import { ARAM_MEASUREMENTS, type AramMeasurement, type DataUnit, type AramGeometry, type WaterfallSeconds } from './aram/types';
import type { PalettePreset } from './aram/palettes';

export type VisualizerRate = 30 | 60 | 'display';

export type AppSettings = {
  mode: AramMeasurement;
  activityUnit: DataUnit;
  dataUnit: DataUnit;
  dataXor: boolean;
  entropyUnit: DataUnit;
  geometry: AramGeometry;
  waterfallSeconds: WaterfallSeconds;
  visualizerRate: VisualizerRate;
  palette: PalettePreset;
  activityByteBackground: boolean;
  byteRefreshDiagnostic: boolean;
  activityPersistence: boolean;
  activityPersistenceMilliseconds: number;
  volume: number;
};

type SettingsFile = {
  format: 'visual-spc-player-settings';
  version: 3;
  settings: AppSettings;
};

export const defaultSettings: AppSettings = {
  mode: 'activity',
  activityUnit: 'byte',
  dataUnit: 'byte', dataXor: false, entropyUnit: 'byte',
  geometry: 'map',
  waterfallSeconds: 5,
  visualizerRate: 30,
  palette: 'spectrum',
  activityByteBackground: false,
  byteRefreshDiagnostic: false,
  activityPersistence: false,
  activityPersistenceMilliseconds: 100,
  volume: 0.8,
};

const modes: readonly string[] = ARAM_MEASUREMENTS;
const legacyModes = ['activity', 'bytes', 'bits', 'xor', 'entropy'] as const;
const legacySelection = (mode: string | null) => ({
  mode: mode === 'bytes' || mode === 'bits' || mode === 'xor' ? 'data' as const : modes.includes(mode ?? '') ? mode as AramMeasurement : 'activity' as const,
  dataUnit: mode === 'bits' ? 'bit' as const : 'byte' as const,
  dataXor: mode === 'xor', entropyUnit: 'byte' as const,
});
const palettes: PalettePreset[] = ['spectrum', 'scope', 'original', 'grayscale', 'accessible'];

export const normalizePersistenceDuration = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(10, Math.min(2000, Math.round(parsed / 10) * 10))
    : defaultSettings.activityPersistenceMilliseconds;
};

const readStorage = () => {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
};

export const loadStoredSettings = (): { settings: AppSettings; warning?: string } => {
  try {
    const storage = readStorage();
    if (!storage) return { settings: { ...defaultSettings } };

    const rawMode = storage.getItem('spc-mode');
    const legacyData = rawMode === 'bytes' || rawMode === 'bits' || rawMode === 'xor';
    const rawGeometry = storage.getItem('spc-geometry');
    const rawSeconds = storage.getItem('spc-waterfall-seconds');
    const rawRate = storage.getItem('spc-hz');
    const rawPalette = storage.getItem('spc-palette');
    const paletteVersion = storage.getItem('spc-palette-version');
    const rawDuration = storage.getItem('spc-activity-persistence-ms');
    const rawVolume = storage.getItem('spc-volume');
    const parsedVolume = rawVolume === null ? NaN : Number(rawVolume);

    let palette: PalettePreset = defaultSettings.palette;
    if (!paletteVersion && (!rawPalette || rawPalette === 'scope')) palette = 'spectrum';
    else if (palettes.includes(rawPalette as PalettePreset)) palette = rawPalette as PalettePreset;

    return {
      settings: {
        ...legacySelection(rawMode),
        activityUnit: storage.getItem('spc-activity-unit') === 'bit' ? 'bit' : 'byte',
        dataUnit: legacyData ? legacySelection(rawMode).dataUnit : storage.getItem('spc-data-unit') === 'bit' ? 'bit' : 'byte',
        dataXor: legacyData ? legacySelection(rawMode).dataXor : storage.getItem('spc-data-xor') === 'on',
        entropyUnit: storage.getItem('spc-entropy-unit') === 'bit' ? 'bit' : 'byte',
        geometry: rawGeometry === 'waterfall' ? 'waterfall' : 'map',
        waterfallSeconds: rawSeconds === '2' ? 2 : rawSeconds === '10' ? 10 : 5,
        visualizerRate: rawRate === 'display' ? 'display' : rawRate === '60' ? 60 : 30,
        palette,
        activityByteBackground: storage.getItem('spc-activity-byte-background') === 'on',
        byteRefreshDiagnostic: storage.getItem('spc-byte-refresh-diagnostic') === 'on',
        activityPersistence: storage.getItem('spc-activity-persistence') === 'on',
        activityPersistenceMilliseconds: rawDuration === null
          ? defaultSettings.activityPersistenceMilliseconds
          : normalizePersistenceDuration(rawDuration),
        volume: Number.isFinite(parsedVolume) && parsedVolume >= 0 && parsedVolume <= 1
          ? parsedVolume
          : defaultSettings.volume,
      },
    };
  } catch (error) {
    console.warn('Visual SPC Player could not read browser settings storage.', error);
    return {
      settings: { ...defaultSettings },
      warning: 'Browser settings storage is unavailable. Changes will last until this page closes.',
    };
  }
};

export const saveStoredSettings = (settings: AppSettings) => {
  try {
    const storage = readStorage();
    if (!storage) throw new Error('Browser settings storage is unavailable.');
    storage.setItem('spc-mode', settings.mode);
    storage.setItem('spc-activity-unit', settings.activityUnit);
    storage.setItem('spc-data-unit', settings.dataUnit);
    storage.setItem('spc-data-xor', settings.dataXor ? 'on' : 'off');
    storage.setItem('spc-entropy-unit', settings.entropyUnit);
    storage.setItem('spc-geometry', settings.geometry);
    storage.setItem('spc-waterfall-seconds', String(settings.waterfallSeconds));
    storage.setItem('spc-hz', String(settings.visualizerRate));
    storage.setItem('spc-palette', settings.palette);
    storage.setItem('spc-palette-version', '2');
    storage.setItem('spc-activity-byte-background', settings.activityByteBackground ? 'on' : 'off');
    storage.setItem('spc-byte-refresh-diagnostic', settings.byteRefreshDiagnostic ? 'on' : 'off');
    storage.setItem('spc-activity-persistence', settings.activityPersistence ? 'on' : 'off');
    storage.setItem('spc-activity-persistence-ms', String(settings.activityPersistenceMilliseconds));
    storage.setItem('spc-volume', String(settings.volume));
    return { ok: true as const };
  } catch (error) {
    console.warn('Visual SPC Player could not save browser settings.', error);
    return {
      ok: false as const,
      message: 'Browser settings storage is unavailable. Export settings to keep a portable copy.',
    };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseSettingsFile = (text: string): AppSettings => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!isRecord(parsed) || !['visual-spc-player-settings', 'spc-memory-scope-settings'].includes(parsed.format as string) || ![1, 2, 3].includes(parsed.version as number) || !isRecord(parsed.settings)) {
    throw new Error('That is not a supported Visual SPC Player settings file.');
  }

  const settings = parsed.settings;
  const supportedModes: readonly string[] = parsed.version === 1 ? ['activity', 'bytes', 'bits'] : parsed.version === 2 ? legacyModes : modes;
  if (!supportedModes.includes(settings.mode as string)
    || (parsed.version !== 1 && (!(settings.geometry === 'map' || settings.geometry === 'waterfall') || ![2, 5, 10].includes(settings.waterfallSeconds as number)))
    || (parsed.version === 3 && (!(settings.dataUnit === 'byte' || settings.dataUnit === 'bit') || typeof settings.dataXor !== 'boolean' || !(settings.entropyUnit === 'byte' || settings.entropyUnit === 'bit')))
    || (parsed.version === 3 && settings.activityUnit !== undefined && settings.activityUnit !== 'byte' && settings.activityUnit !== 'bit')
    || !(settings.visualizerRate === 30 || settings.visualizerRate === 60 || settings.visualizerRate === 'display')
    || !palettes.includes(settings.palette as PalettePreset)
    || (settings.activityByteBackground !== undefined && typeof settings.activityByteBackground !== 'boolean')
    || (settings.byteRefreshDiagnostic !== undefined && typeof settings.byteRefreshDiagnostic !== 'boolean')
    || typeof settings.activityPersistence !== 'boolean'
    || typeof settings.activityPersistenceMilliseconds !== 'number'
    || !Number.isFinite(settings.activityPersistenceMilliseconds)
    || settings.activityPersistenceMilliseconds < 10
    || settings.activityPersistenceMilliseconds > 2000
    || typeof settings.volume !== 'number'
    || !Number.isFinite(settings.volume)
    || settings.volume < 0
    || settings.volume > 1) {
    throw new Error('The settings file contains an invalid value.');
  }

  return {
    activityUnit: parsed.version === 3 && settings.activityUnit === 'bit' ? 'bit' : 'byte',
    ...(parsed.version === 3 ? { mode: settings.mode as AramMeasurement, dataUnit: settings.dataUnit as DataUnit, dataXor: settings.dataXor as boolean, entropyUnit: settings.entropyUnit as DataUnit } : legacySelection(settings.mode as string)),
    geometry: parsed.version === 1 ? 'map' : settings.geometry as AramGeometry,
    waterfallSeconds: parsed.version === 1 ? 5 : settings.waterfallSeconds as WaterfallSeconds,
    visualizerRate: settings.visualizerRate as VisualizerRate,
    palette: settings.palette as PalettePreset,
    activityByteBackground: settings.activityByteBackground === true,
    byteRefreshDiagnostic: settings.byteRefreshDiagnostic === true,
    activityPersistence: settings.activityPersistence,
    activityPersistenceMilliseconds: normalizePersistenceDuration(settings.activityPersistenceMilliseconds),
    volume: settings.volume,
  };
};

export const serializeSettingsFile = (settings: AppSettings) => JSON.stringify({
  format: 'visual-spc-player-settings',
  version: 3,
  settings,
} satisfies SettingsFile, null, 2) + '\n';
