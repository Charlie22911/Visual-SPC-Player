import { useEffect, useMemo, useRef, useState } from 'react';
import { AramPanel } from './aram/AramPanel';
import { MemoryHistory } from './aram/history';
import { renderingMode, type AramMeasurement, type DataUnit } from './aram/types';
import type { PalettePreset } from './aram/palettes';
import { SpcAudioEngine, type EngineState } from './audio/engine';
import type { Snapshot } from './audio/protocol';
import { DisplayRefreshTracker } from './displayRefresh';
import {
  buildLibraryEntries,
  enumerateDirectory,
  filesFromInput,
  listLibraryDirectory,
  stripLibraryRoot,
  type FileSystemDirectoryHandleLike,
  type LibraryEntry,
  type LibraryFileDescriptor,
} from './library/library';
import { readSpcMetadata, type SpcMetadata } from './library/metadata';
import {
  descriptorsFromSavedFiles,
  loadSavedLibrary,
  saveDirectoryLibrary,
  saveFileLibrary,
  type SavedLibrary,
} from './library/storage';
import { DspPanel } from './player/DspPanel';
import { VoicesPanel } from './player/VoicesPanel';
import { registerSpcWebTools, type WebModelContext } from './webmcp';
import { VisualDiagnostics } from './audio/VisualDiagnostics';
import { ByteRefreshDiagnostics } from './audio/ByteRefreshDiagnostics';
import { ByteRefreshMonitor } from './audio/byteRefresh';
import { PresentationQueue } from './audio/presentationQueue';
import { VisualStream } from './audio/visualStream';
import {
  loadStoredSettings,
  normalizePersistenceDuration,
  parseSettingsFile,
  saveStoredSettings,
  serializeSettingsFile,
  type AppSettings,
} from './settings';
import { getStandaloneAssets, isStandaloneBuild, standaloneTextUrl } from './standalone';
import './app.css';

type Tab = 'aram' | 'voices' | 'dsp' | 'track' | 'settings';
type ActiveLibrarySource =
  | { kind: 'directory'; name: string; handle: FileSystemDirectoryHandleLike }
  | { kind: 'files'; name: string; descriptors: LibraryFileDescriptor[] };

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'read' }) => Promise<FileSystemDirectoryHandleLike>;
};

const formatTime = (frames: number) => {
  const seconds = Math.max(0, Math.floor(frames / 32000));
  return Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + (seconds % 60).toString().padStart(2, '0');
};

export default function App() {
  const engine = useMemo(() => new SpcAudioEngine(), []);
  const visualStream = useMemo(() => new VisualStream(), []);
  const memoryHistory = useMemo(() => new MemoryHistory(), []);
  const lastUiUpdate = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const settingsInput = useRef<HTMLInputElement>(null);
  const webState = useRef({ loaded: false, playing: false, trackTitle: null as string | null, aramMode: 'activity' as AramMeasurement, activityUnit: 'byte' as DataUnit, dataUnit: 'byte' as DataUnit, dataXor: false, entropyUnit: 'byte' as DataUnit });
  const expectedRequest = useRef(0);
  const expectedGeneration = useRef(0);
  const lastSequence = useRef(0);
  const presentation = useMemo(() => new PresentationQueue(), []);
  const animationFrame = useRef(0);
  const scanController = useRef<AbortController | null>(null);
  const scanToken = useRef(0);
  const retryEntry = useRef<LibraryEntry | null>(null);
  const librarySource = useRef<ActiveLibrarySource | null>(null);
  const librarySelectionVersion = useRef(0);
  const [initialSettings] = useState(loadStoredSettings);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<SpcMetadata | null>(null);
  const [pendingTitle, setPendingTitle] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState(initialSettings.settings.mode);
  const [activityUnit, setActivityUnit] = useState(initialSettings.settings.activityUnit);
  const [dataUnit, setDataUnit] = useState(initialSettings.settings.dataUnit);
  const [dataXor, setDataXor] = useState(initialSettings.settings.dataXor);
  const [entropyUnit, setEntropyUnit] = useState(initialSettings.settings.entropyUnit);
  const [geometry, setGeometry] = useState(initialSettings.settings.geometry);
  const [waterfallSeconds, setWaterfallSeconds] = useState(initialSettings.settings.waterfallSeconds);
  const [hz, setHz] = useState(initialSettings.settings.visualizerRate);
  const [detectedDisplayHz, setDetectedDisplayHz] = useState<number | null>(null);
  const [activityPersistence, setActivityPersistence] = useState(initialSettings.settings.activityPersistence);
  const [activityByteBackground, setActivityByteBackground] = useState(initialSettings.settings.activityByteBackground);
  const [byteRefreshDiagnostic, setByteRefreshDiagnostic] = useState(initialSettings.settings.byteRefreshDiagnostic);
  const byteRefreshMonitor = useMemo(() => byteRefreshDiagnostic ? new ByteRefreshMonitor() : null, [byteRefreshDiagnostic]);
  useEffect(() => {
    visualStream.byteRefresh = byteRefreshMonitor;
    return () => { visualStream.byteRefresh = null; };
  }, [visualStream, byteRefreshMonitor]);
  const [activityPersistenceMilliseconds, setActivityPersistenceMilliseconds] = useState(
    initialSettings.settings.activityPersistenceMilliseconds,
  );
  const [palette, setPalette] = useState<PalettePreset>(initialSettings.settings.palette);
  const [tab, setTab] = useState<Tab>('aram');
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [audibleFrame, setAudibleFrame] = useState(0);
  const [volume, setVolume] = useState(initialSettings.settings.volume);
  const [error, setError] = useState('');
  const [libraryName, setLibraryName] = useState('No library selected');
  const [folder, setFolder] = useState('');
  const [visibleCount, setVisibleCount] = useState(500);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [useDirectoryInput, setUseDirectoryInput] = useState(false);
  const [savedDirectory, setSavedDirectory] = useState<Extract<SavedLibrary, { kind: 'directory' }> | null>(null);
  const [librarySaving, setLibrarySaving] = useState(false);
  const [librarySaveStatus, setLibrarySaveStatus] = useState('');
  const [settingsSaveStatus, setSettingsSaveStatus] = useState(initialSettings.warning ?? '');
  const [engineStatus, setEngineStatus] = useState<EngineState>('idle');
  const [offlineReady, setOfflineReady] = useState(isStandaloneBuild);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [droppedSnapshots, setDroppedSnapshots] = useState(0);
  const effectiveHz = hz === 'display' ? detectedDisplayHz ?? 60 : hz;
  const standaloneAssets = getStandaloneAssets();
  const noticesHref = standaloneAssets ? standaloneTextUrl(standaloneAssets.noticesBase64) : './NOTICE.txt';
  const sourceHref = standaloneAssets ? standaloneTextUrl(standaloneAssets.sourceBase64) : './spc-core-source.txt';

  webState.current = {
    loaded,
    playing,
    trackTitle: metadata?.title || (loaded ? pendingTitle || null : null),
    aramMode: mode,
    activityUnit, dataUnit, dataXor, entropyUnit,
  };

  useEffect(() => {
    const context = (document as Document & { modelContext?: WebModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = registerSpcWebTools({
      context,
      getState: () => webState.current,
      setAramMode: (nextMode) => new Promise<void>((resolve) => {
        if (nextMode === 'bytes' || nextMode === 'bits' || nextMode === 'xor') {
          setMode('data'); setDataUnit(nextMode === 'bits' ? 'bit' : 'byte'); setDataXor(nextMode === 'xor');
        } else setMode(nextMode);
        setTab('aram');
        requestAnimationFrame(() => resolve());
      }),
      setAramOptions: options => new Promise<void>(resolve => {
        if (options.activityUnit !== undefined) setActivityUnit(options.activityUnit);
        if (options.dataUnit !== undefined) setDataUnit(options.dataUnit);
        if (options.dataXor !== undefined) setDataXor(options.dataXor);
        if (options.entropyUnit !== undefined) setEntropyUnit(options.entropyUnit);
        setSettingsSaveStatus(''); requestAnimationFrame(() => resolve());
      }),
    });
    return () => lifecycle.abort();
  }, []);

  useEffect(() => {
    const offSnapshot = engine.on('snapshot', (event) => {
      if (event.requestId !== expectedRequest.current) return;
      if (event.generation !== expectedGeneration.current || event.sequence <= lastSequence.current) return;
      visualStream.receivedSnapshot(event);
      presentation.enqueue(event, performance.now());
    });
    // Stay scheduled even between audio-message bursts. The queue retains
    // intermediate states instead of overwriting an entire burst with its tail.
    const present = (now: number) => {
      animationFrame.current = requestAnimationFrame(present);
      const next = presentation.take(now);
      visualStream.coalesced = presentation.combined;
      visualStream.queueOverflows = presentation.overflows;
      if (!next || next.requestId !== expectedRequest.current || next.generation !== expectedGeneration.current) return;
      lastSequence.current = next.sequence;
      memoryHistory.accept(next, presentation.discontinuities);
      visualStream.publish(next);
      // Only the transport and general UI are throttled. All live visual
      // panels paint directly from the stream above at the chosen cadence.
      if (now - lastUiUpdate.current < 100) return;
      lastUiUpdate.current = now;
      setSnapshot(next);
      setAudibleFrame(next.audibleFrame);
    };
    animationFrame.current = requestAnimationFrame(present);
    const offState = engine.on('state', (event) => {
      if (expectedGeneration.current && event.generation !== expectedGeneration.current) return;
      setPlaying(event.playing);
      setAudibleFrame(event.audibleFrame);
      setDroppedSnapshots(event.droppedSnapshots);
    });
    const offError = engine.on('error', (event) => setError(event.message));
    const offStatus = engine.on('status', (event) => setEngineStatus(event.state));
    const offline = () => setOfflineReady(true);
    const update = () => setUpdateAvailable(true);
    window.addEventListener('spc-offline-ready', offline);
    window.addEventListener('spc-update-available', update);
    return () => {
      offSnapshot();
      offState();
      offError();
      offStatus();
      window.removeEventListener('spc-offline-ready', offline);
      window.removeEventListener('spc-update-available', update);
      if (animationFrame.current) cancelAnimationFrame(animationFrame.current);
      scanController.current?.abort();
      void engine.dispose();
    };
  }, [engine, presentation, visualStream, memoryHistory]);

  useEffect(() => {
    const tracker = new DisplayRefreshTracker();
    let frame = 0;
    let reportedHz: number | null = null;
    const measure = (timestamp: number) => {
      const measured = tracker.addFrame(timestamp);
      if (measured !== null && (reportedHz === null || Math.abs(reportedHz - measured) >= 2)) {
        reportedHz = measured;
        presentation.setDisplayFrameDuration(1000 / measured);
        setDetectedDisplayHz(measured);
      }
      frame = requestAnimationFrame(measure);
    };
    const reset = () => tracker.reset();
    frame = requestAnimationFrame(measure);
    document.addEventListener('visibilitychange', reset);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [presentation]);

  useEffect(() => {
    engine.setVolume(volume);
  }, [engine, volume]);

  useEffect(() => {
    // Every snapshot contains both ARAM values and activity. Changing the
    // client-side palette/mode must not invalidate an in-flight memory frame.
    if (loaded) expectedRequest.current = engine.setView('activity', hz === 'display' ? 60 : hz, hz === 'display');
  }, [engine, hz, loaded]);

  const listing = useMemo(() => listLibraryDirectory(entries, folder, query), [entries, folder, query]);
  const breadcrumbs = useMemo(() => {
    const segments = folder ? folder.split('/') : [];
    return segments.map((name, index) => ({
      name,
      path: segments.slice(0, index + 1).join('/'),
    }));
  }, [folder]);
  const parentFolder = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';

  useEffect(() => setVisibleCount(500), [folder, query, entries]);

  const beginLibrarySelection = () => {
    librarySelectionVersion.current += 1;
    return librarySelectionVersion.current;
  };

  const installLibrary = (
    name: string,
    descriptors: LibraryFileDescriptor[],
    source: ActiveLibrarySource,
  ) => {
    scanController.current?.abort();
    scanToken.current += 1;
    setScanning(false);
    const session = Date.now().toString(36);
    const nextEntries = buildLibraryEntries(session, descriptors);
    if (!nextEntries.length) {
      setError('No SPC files were found in that selection. Choose a folder containing .spc files, or use Open SPC files.');
      return;
    }
    librarySource.current = source;
    setSavedDirectory(null);
    setLibrarySaveStatus('');
    setError('');
    setEntries(nextEntries);
    setLibraryName(name);
    setQuery('');
    setFolder('');
    setVisibleCount(500);
  };

  const restoreDirectoryLibrary = async (
    saved: Extract<SavedLibrary, { kind: 'directory' }>,
    requestPermission: boolean,
    expectedSelectionVersion = librarySelectionVersion.current,
  ) => {
    const isStale = () => expectedSelectionVersion !== librarySelectionVersion.current;
    let permission: 'granted' | 'denied' | 'prompt';
    try {
      permission = requestPermission
        ? await saved.handle.requestPermission?.({ mode: 'read' }) ?? 'granted'
        : await saved.handle.queryPermission?.({ mode: 'read' }) ?? 'granted';
    } catch (caught) {
      if (isStale()) return;
      setSavedDirectory(saved);
      setLibraryName(saved.name + ' · permission required');
      if (requestPermission) setLibrarySaveStatus(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    if (isStale()) return;
    if (permission !== 'granted') {
      setSavedDirectory(saved);
      setLibraryName(saved.name + ' · permission required');
      setLibrarySaveStatus('Folder permission is required to restore this saved library.');
      return;
    }
    const controller = new AbortController();
    scanController.current?.abort();
    scanController.current = controller;
    const token = ++scanToken.current;
    setScanning(true);
    setScanProgress(0);
    try {
      const descriptors = await enumerateDirectory(saved.handle, {
        signal: controller.signal,
        onProgress: (count) => token === scanToken.current && !isStale() && setScanProgress(count),
      });
      if (token === scanToken.current && !isStale()) {
        installLibrary(saved.name, descriptors, { kind: 'directory', name: saved.name, handle: saved.handle });
        setLibrarySaveStatus('Saved library restored');
      }
    } catch (caught) {
      if (!isStale() && !(caught instanceof DOMException && caught.name === 'AbortError')) {
        setLibrarySaveStatus(`Saved library could not be restored: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    } finally {
      if (token === scanToken.current) setScanning(false);
    }
  };

  useEffect(() => {
    let canceled = false;
    const expectedSelectionVersion = librarySelectionVersion.current;
    void loadSavedLibrary().then((saved) => {
      if (canceled || !saved || expectedSelectionVersion !== librarySelectionVersion.current) return;
      if (saved.kind === 'directory') {
        void restoreDirectoryLibrary(saved, false, expectedSelectionVersion);
        return;
      }
      const descriptors = descriptorsFromSavedFiles(saved);
      if (expectedSelectionVersion !== librarySelectionVersion.current) return;
      installLibrary(saved.name, descriptors, { kind: 'files', name: saved.name, descriptors });
      setLibrarySaveStatus('Saved library restored');
    }).catch((caught) => {
      if (!canceled && expectedSelectionVersion === librarySelectionVersion.current) {
        setLibrarySaveStatus(`Saved library could not be restored: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    });
    return () => { canceled = true; };
  }, []);

  const saveCurrentLibrary = async () => {
    const source = librarySource.current;
    if (!source) return;
    setLibrarySaving(true);
    setLibrarySaveStatus('Saving library…');
    try {
      if (source.kind === 'directory') await saveDirectoryLibrary(source.name, source.handle);
      else await saveFileLibrary(source.name, source.descriptors);
      setLibrarySaveStatus('Library saved on this device');
    } catch (caught) {
      setLibrarySaveStatus(`Library could not be saved: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setLibrarySaving(false);
    }
  };

  const currentSettings = (): AppSettings => ({
    mode,
    activityUnit, dataUnit, dataXor, entropyUnit,
    geometry,
    waterfallSeconds,
    visualizerRate: hz,
    palette,
    activityPersistence,
    activityByteBackground,
    byteRefreshDiagnostic,
    activityPersistenceMilliseconds,
    volume,
  });

  const saveSettings = () => {
    const result = saveStoredSettings(currentSettings());
    setSettingsSaveStatus(result.ok ? 'Settings saved in this browser' : result.message);
  };

  const exportSettings = () => {
    try {
      const blob = new Blob([serializeSettingsFile(currentSettings())], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'Visual-SPC-Player-settings.json';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setSettingsSaveStatus('Portable settings file exported');
    } catch (caught) {
      setSettingsSaveStatus(`Settings could not be exported: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const importSettings = async (file: File) => {
    try {
      const imported = parseSettingsFile(await file.text());
      setMode(imported.mode);
      setActivityUnit(imported.activityUnit);
      setDataUnit(imported.dataUnit); setDataXor(imported.dataXor); setEntropyUnit(imported.entropyUnit);
      setGeometry(imported.geometry);
      setWaterfallSeconds(imported.waterfallSeconds);
      setHz(imported.visualizerRate);
      setPalette(imported.palette);
      setActivityPersistence(imported.activityPersistence);
      setActivityByteBackground(imported.activityByteBackground);
      setByteRefreshDiagnostic(imported.byteRefreshDiagnostic);
      setActivityPersistenceMilliseconds(imported.activityPersistenceMilliseconds);
      setVolume(imported.volume);
      setSettingsSaveStatus('Settings imported. Use Save settings to keep them in this browser.');
    } catch (caught) {
      setSettingsSaveStatus(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const openFileInput = () => {
    beginLibrarySelection();
    if (fileInput.current) fileInput.current.value = '';
    fileInput.current?.click();
  };

  const openDirectoryInput = () => {
    const input = folderInput.current;
    if (!input || !('webkitdirectory' in input)) {
      setError('This browser does not support selecting folders. Use Open SPC files to select one or more tracks.');
      return;
    }
    input.value = '';
    input.click();
  };

  const openFolder = async () => {
    const selectionVersion = beginLibrarySelection();
    setError('');
    scanController.current?.abort();
    const controller = new AbortController();
    scanController.current = controller;
    const token = ++scanToken.current;
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (typeof picker !== 'function' || useDirectoryInput) {
      setScanning(false);
      openDirectoryInput();
      return;
    }
    try {
      const handle = await picker.call(window, { mode: 'read' });
      if (token !== scanToken.current || controller.signal.aborted || selectionVersion !== librarySelectionVersion.current) return;
      setScanning(true);
      setScanProgress(0);
      const descriptors = await enumerateDirectory(handle, {
        signal: controller.signal,
        onProgress: (count) => token === scanToken.current && selectionVersion === librarySelectionVersion.current && setScanProgress(count),
      });
      if (token === scanToken.current && selectionVersion === librarySelectionVersion.current) {
        installLibrary(handle.name, descriptors, { kind: 'directory', name: handle.name, handle });
      }
    } catch (caught) {
      if (token !== scanToken.current || selectionVersion !== librarySelectionVersion.current) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      // A second explicit tap preserves the user gesture required by Safari
      // and browsers which expose but block the File System Access picker.
      setUseDirectoryInput(true);
      setError('The folder picker could not open. Tap Open folder again to try the browser file picker, or use Open SPC files.');
    } finally {
      if (token === scanToken.current) setScanning(false);
    }
  };

  const choose = async (entry: LibraryEntry) => {
    const loadId = engine.reserveLoad();
    const activation = engine.beginUserGesture();
    void activation.catch(() => undefined);
    setPendingId(entry.id);
    setPendingTitle(entry.name.replace(/\.spc$/i, ''));
    setLoading(true);
    setError('');
    try {
      const file = entry.file ?? await entry.open?.();
      if (!file || !engine.isCurrentLoad(loadId)) return;
      const [nextMetadata, generation] = await Promise.all([
        readSpcMetadata(file),
        engine.loadFile(file, false, loadId, activation),
      ]);
      if (!engine.isCurrentLoad(loadId)) return;
      expectedGeneration.current = generation;
      memoryHistory.reset(generation);
      lastSequence.current = 0;
      setSnapshot(null);
      visualStream.latest = null;
      presentation.clear();
      lastUiUpdate.current = 0;
      expectedRequest.current = engine.setView('activity', hz === 'display' ? 60 : hz, hz === 'display');
      setMetadata(nextMetadata);
      retryEntry.current = null;
      setSelectedId(entry.id);
      setLoaded(true);
      setPlaying(true);
      setAudibleFrame(0);
      setTab('aram');
    } catch (caught) {
      if (engine.isCurrentLoad(loadId)) {
        retryEntry.current = entry;
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (engine.isCurrentLoad(loadId)) {
        setLoading(false);
        setPendingTitle('');
        setPendingId(null);
      }
    }
  };

  const recoverAudio = async () => {
    setError('');
    try {
      if (engineStatus === 'interrupted') {
        await engine.resume();
        return;
      }
      const retry = retryEntry.current;
      if (retry) await choose(retry);
      else await engine.beginUserGesture();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const tabs: Array<[Tab, string]> = [
    ['aram', 'ARAM'],
    ['voices', 'Voices'],
    ['dsp', 'DSP'],
    ['track', 'Track'],
    ['settings', 'Settings'],
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <div><strong>Visual SPC Player</strong><span>SPC700 / S-DSP player</span></div>
        </div>
        <div className="now-playing">
          <span className="eyebrow">{loading ? 'Loading' : engineStatus === 'failed' ? 'Audio failed' : engineStatus === 'interrupted' ? 'Audio interrupted' : loaded ? (playing ? 'Playing' : 'Paused') : 'Ready'}</span>
          <strong>{loading ? pendingTitle : metadata?.title || 'Choose an SPC file'}</strong>
          <span>{metadata?.game || libraryName}</span>
        </div>
        <div className="transport">
          <time>{formatTime(audibleFrame)}</time>
          <button onClick={() => {
            if (!loaded) {
              openFileInput();
              return;
            }
            engine.setPaused(playing);
          }}>{playing ? 'Pause' : 'Play'}</button>
          <button onClick={() => {
            if (!loaded) return;
            void engine.restart().then((generation) => {
              expectedGeneration.current = generation;
              memoryHistory.reset(generation);
              lastSequence.current = 0;
              setSnapshot(null);
              visualStream.latest = null;
              presentation.clear();
              lastUiUpdate.current = 0;
              expectedRequest.current = engine.setView('activity', hz === 'display' ? 60 : hz, hz === 'display');
            }).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
          }} disabled={!loaded}>Restart</button>
          <label className="volume">Volume
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(event) => {
                const next = Number(event.target.value);
                setVolume(next);
                setSettingsSaveStatus('');
              }}
            />
          </label>
        </div>
      </header>

      <div className="status-banners">
        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
        {(engineStatus === 'interrupted' || engineStatus === 'failed') && (
          <div className="audio-banner" role="status">
            <span>{engineStatus === 'interrupted'
              ? 'Audio was suspended by the browser.'
              : 'The audio engine could not start.'}</span>
            <button onClick={() => void recoverAudio()}>{engineStatus === 'interrupted' ? 'Resume audio' : 'Retry audio initialization'}</button>
          </div>
        )}
      </div>

      <div className="workspace">
        <aside className="library-panel">
          <div className="library-heading">
            <div><span className="eyebrow">Local files</span><h1>Library</h1></div>
            <span className="track-count">{entries.length}</span>
          </div>
          <div className="library-actions">
            <button className="primary" onClick={() => void openFolder()}>Open folder</button>
            <button onClick={openFileInput}>Open SPC files</button>
            <button disabled={!entries.length || librarySaving} onClick={() => void saveCurrentLibrary()}>
              {librarySaving ? 'Saving…' : 'Save library'}
            </button>
            {savedDirectory && (
              <button onClick={() => {
                const selectionVersion = beginLibrarySelection();
                void restoreDirectoryLibrary(savedDirectory, true, selectionVersion);
              }}>Restore saved</button>
            )}
            {scanning && <button onClick={() => scanController.current?.abort()}>Cancel scan</button>}
          </div>
          {scanning && <div className="scan-progress" role="status">Scanning… {scanProgress.toLocaleString()} SPC files found</div>}
          {librarySaveStatus && <div className="save-status" role="status">{librarySaveStatus}</div>}
          <input
            ref={fileInput}
            hidden
            type="file"
            accept=".spc"
            multiple
            onChange={(event) => {
              if (!event.target.files?.length) return;
              const descriptors = filesFromInput(event.target.files);
              installLibrary('Selected SPC files', descriptors, {
                kind: 'files',
                name: 'Selected SPC files',
                descriptors,
              });
              event.target.value = '';
            }}
          />
          <input
            ref={(input) => {
              folderInput.current = input;
              // Set the native directory attribute explicitly; do not rely on
              // React interpreting an empty-string boolean attribute.
              if (input) input.setAttribute('webkitdirectory', '');
            }}
            hidden
            type="file"
            multiple
            onChange={(event) => {
              if (!event.target.files?.length) {
                setError('No files were returned by the folder picker. Try a folder stored on this device, or use Open SPC files.');
                return;
              }
              const descriptors = filesFromInput(event.target.files);
              const root = descriptors[0]?.relativePath.split('/')[0] || 'Selected folder';
              const stripped = stripLibraryRoot(descriptors, root);
              installLibrary(root, stripped, { kind: 'files', name: root, descriptors: stripped });
              event.target.value = '';
            }}
          />
          <label className="search-box">
            <span className="sr-only">Search library</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search folders and tracks" />
          </label>
          <div className="library-name">{libraryName}</div>
          {entries.length > 0 && (
            <nav className="library-breadcrumbs" aria-label="Library folder">
              <button onClick={() => setFolder('')} aria-current={!folder ? 'page' : undefined}>Library</button>
              {breadcrumbs.map((crumb, index) => (
                <span key={crumb.path}>
                  <i aria-hidden="true">/</i>
                  <button onClick={() => setFolder(crumb.path)} aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}>{crumb.name}</button>
                </span>
              ))}
            </nav>
          )}
          {folder && !query && (
            <button className="library-up" onClick={() => setFolder(parentFolder)}>
              <span aria-hidden="true">←</span> Up
            </button>
          )}
          {query && (
            <div className="library-search-scope">Searching all {entries.length.toLocaleString()} tracks</div>
          )}
          <div className="track-list">
            {!query && listing.folders.map((child) => (
              <button className="folder-entry" key={child.path} onClick={() => setFolder(child.path)}>
                <span className="folder-title"><i aria-hidden="true">▸</i><strong>{child.name}</strong></span>
                <span>{child.trackCount.toLocaleString()} {child.trackCount === 1 ? 'track' : 'tracks'}</span>
              </button>
            ))}
            {listing.tracks.slice(0, visibleCount).map((entry) => (
              <button
                key={entry.id}
                className={selectedId === entry.id ? 'selected' : pendingId === entry.id ? 'pending' : ''}
                aria-current={selectedId === entry.id ? 'true' : undefined}
                onClick={() => void choose(entry)}
              >
                <strong>{entry.name.replace(/\.spc$/i, '')}</strong>
                <span>{query ? entry.folder : 'SPC file'}</span>
              </button>
            ))}
            {entries.length === 0 && (
              <div className="library-empty">
                <strong>Your music stays on this device.</strong>
                <span>Select a folder on supported browsers, or choose one or more SPC files.</span>
              </div>
            )}
            {entries.length > 0 && listing.folders.length === 0 && listing.tracks.length === 0 && (
              <div className="library-empty">
                <strong>{query ? 'No matching tracks' : 'No tracks in this folder'}</strong>
                <span>{query ? 'Try a different title or folder name.' : 'Choose another folder from the path above.'}</span>
              </div>
            )}
            {listing.tracks.length > visibleCount && (
              <button className="load-more" onClick={() => setVisibleCount((count) => count + 500)}>
                Show next {Math.min(500, listing.tracks.length - visibleCount).toLocaleString()} of {listing.tracks.length.toLocaleString()}
              </button>
            )}
          </div>
        </aside>

        <main className="main-panel">
          <nav className="view-tabs" aria-label="Player views">
            {tabs.map(([value, label]) => (
              <button key={value} onClick={() => setTab(value)} className={tab === value ? 'active' : ''} aria-pressed={tab === value}>{label}</button>
            ))}
          </nav>
          <div className={`view-content${tab === 'aram' ? ' aram-view-content' : ''}`}>
            {tab === 'aram' && <AramPanel activityUnit={activityUnit} onActivityUnitChange={(next) => { setActivityUnit(next); setSettingsSaveStatus(''); }} mode={mode} onModeChange={(next) => { setMode(next); setSettingsSaveStatus(''); }} dataUnit={dataUnit} dataXor={dataXor} entropyUnit={entropyUnit} onDataUnitChange={(next) => { setDataUnit(next); setSettingsSaveStatus(''); }} onDataXorChange={(next) => { setDataXor(next); setSettingsSaveStatus(''); }} onEntropyUnitChange={(next) => { setEntropyUnit(next); setSettingsSaveStatus(''); }} geometry={geometry} onGeometryChange={(next) => { setGeometry(next); setSettingsSaveStatus(''); }} waterfallSeconds={waterfallSeconds} onWaterfallSecondsChange={(next) => { setWaterfallSeconds(next); setSettingsSaveStatus(''); }} activityByteBackground={activityByteBackground} onActivityByteBackgroundChange={(next) => { setActivityByteBackground(next); setSettingsSaveStatus(''); }} history={memoryHistory} playing={playing} snapshot={snapshot} stream={visualStream} generation={expectedGeneration.current} palette={palette} activityPersistence={activityPersistence} activityPersistenceMilliseconds={activityPersistenceMilliseconds} refreshRate={hz} displayHz={detectedDisplayHz} />}
            {tab === 'voices' && <VoicesPanel stream={visualStream} generation={expectedGeneration.current} onError={setError} />}
            {tab === 'dsp' && <DspPanel stream={visualStream} generation={expectedGeneration.current} onError={setError} />}
            {tab === 'track' && (
              <section className="detail-panel track-detail">
                <div className="section-heading"><div><span className="eyebrow">ID666</span><h2>Track information</h2></div></div>
                <dl>
                  {[
                    ['Title', metadata?.title],
                    ['Game', metadata?.game],
                    ['Artist', metadata?.artist],
                    ['Dumper', metadata?.dumper],
                    ['Comments', metadata?.comments],
                    ['Playback', metadata?.hasId666 ? 'ID666 metadata present · plays indefinitely' : 'No ID666 tags · plays indefinitely'],
                  ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}
                </dl>
              </section>
            )}
            {tab === 'settings' && (
              <section className="detail-panel settings-panel">
                <div className="section-heading"><div><span className="eyebrow">Runtime</span><h2>Settings & diagnostics</h2></div></div>
                <div className="setting-row">
                  <div><strong>Visualizer rate</strong><span>How often copied ARAM and DSP state is published. Presentation stays one measured display frame behind incoming data to smooth audio delivery bursts. The measured cadence does not throttle emulation.</span></div>
                  <div className="segmented">
                    {[30, 60].map((value) => <button key={value} className={hz === value ? 'active' : ''} aria-pressed={hz === value} onClick={() => { setHz(value as 30 | 60); setSettingsSaveStatus(''); }}>{value} Hz</button>)}
                    <button className={hz === 'display' ? 'active' : ''} aria-pressed={hz === 'display'} onClick={() => { setHz('display'); setSettingsSaveStatus(''); }}>Display · {detectedDisplayHz ?? '…'} Hz</button>
                  </div>
                </div>
                <div className="setting-row">
                  <div><strong>Activity persistence</strong><span>Keep recent reads, writes, and execution visible in Activity, Byte values, and Bits. Activity with bytes underneath uses synchronized samples and bypasses persistence.</span></div>
                  <div className="persistence-controls">
                    <div className="segmented">
                      <button className={!activityPersistence ? 'active' : ''} aria-pressed={!activityPersistence} onClick={() => { setActivityPersistence(false); setSettingsSaveStatus(''); }}>Off</button>
                      <button className={activityPersistence ? 'active' : ''} aria-pressed={activityPersistence} onClick={() => { setActivityPersistence(true); setSettingsSaveStatus(''); }}>On</button>
                    </div>
                    <label>
                      Duration
                      <input
                        type="range"
                        min="10"
                        max="2000"
                        step="10"
                        disabled={!activityPersistence}
                        value={activityPersistenceMilliseconds}
                        onChange={(event) => {
                          setActivityPersistenceMilliseconds(normalizePersistenceDuration(event.target.value));
                          setSettingsSaveStatus('');
                        }}
                      />
                      <output>{activityPersistenceMilliseconds.toLocaleString()} ms</output>
                    </label>
                  </div>
                </div>
                <div className="setting-row">
                  <div><strong>Color palette</strong><span>Choose the memory-map colors that are easiest for you to read.</span></div>
                  <select value={palette} onChange={(event) => { setPalette(event.target.value as PalettePreset); setSettingsSaveStatus(''); }}>
                    <option value="spectrum">Spectrum (default)</option>
                    <option value="scope">Scope</option>
                    <option value="original">Original-inspired</option>
                    <option value="grayscale">Grayscale</option>
                    <option value="accessible">Color-vision accessible</option>
                  </select>
                </div>
                <div className="settings-actions">
                  <label className="byte-diagnostic-toggle"><input type="checkbox" checked={byteRefreshDiagnostic} onChange={event => { setByteRefreshDiagnostic(event.target.checked); setSettingsSaveStatus(''); }} /> Byte refresh diagnostic</label>
                </div>
                <p className="technical-note">Show a collapsible measurement panel in ARAM. Use Save measurements in that panel to download the results.</p>
                <div className="settings-actions">
                  <button className="primary" onClick={saveSettings}>Save settings</button>
                  <button onClick={exportSettings}>Export settings</button>
                  <button onClick={() => settingsInput.current?.click()}>Import settings</button>
                  <input
                    ref={settingsInput}
                    hidden
                    type="file"
                    accept=".json,application/json"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importSettings(file);
                      event.target.value = '';
                    }}
                  />
                  {settingsSaveStatus && <span className="save-status" role="status">{settingsSaveStatus}</span>}
                </div>
                <div className="diagnostic-grid">
                  <div><span>Emulator</span><strong>32,000 Hz stereo</strong></div>
                  <div><span>Device output</span><strong>{engine.sampleRate ? engine.sampleRate.toLocaleString() + ' Hz' : 'Starts with playback'}</strong></div>
                  <div><span>Audio context</span><strong>{engine.contextState}</strong></div>
                  <div><span>Memory view</span><strong>{snapshot ? 'Live copy' : 'Waiting for track'}</strong></div>
                  <div><span>Offline use</span><strong>{standaloneAssets ? 'Application embedded in this file' : offlineReady ? 'Available offline' : 'Preparing offline files'}</strong></div>
                  <div><span>Engine state</span><strong>{engineStatus}</strong></div>
                  <div><span>Visual target</span><strong>{hz === 'display' ? 'Every display frame' : effectiveHz.toLocaleString() + ' Hz'}</strong></div>
                  {standaloneAssets && <div><span>Standalone build</span><strong>{standaloneAssets.buildId}</strong></div>}
                  <VisualDiagnostics stream={visualStream} displayHz={detectedDisplayHz} />
                  <div><span>Snapshot buffer drops</span><strong>{droppedSnapshots.toLocaleString()}</strong></div>
                </div>
                {!standaloneAssets && updateAvailable && <button className="primary" onClick={() => window.dispatchEvent(new CustomEvent('spc-activate-update'))}>Update and reload</button>}
                {standaloneAssets && <p className="technical-note">To update this standalone copy, replace this HTML file with a newer build.</p>}
                <p className="technical-note">The final 64 bytes may show the emulator-visible IPL ROM overlay. The display is a copied memory image and does not alter emulation.</p>
                <p className="technical-note"><a href={noticesHref} target="_blank" rel="noreferrer">Licenses and notices</a> · <a href={sourceHref} target="_blank" rel="noreferrer">Bundled emulator source</a></p>
              </section>
            )}
          </div>
        </main>
      </div>
      {byteRefreshMonitor && <ByteRefreshDiagnostics monitor={byteRefreshMonitor} mode={renderingMode({ mode, activityUnit, dataUnit, dataXor, entropyUnit })} geometry={geometry} target={hz} buildId={standaloneAssets?.buildId} hidden={tab !== 'aram'} />}
    </div>
  );
}
