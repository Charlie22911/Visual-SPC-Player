import workletUrl from './spc.worklet.ts?worker&url';
import type { AramMode } from '../aram/renderer';
import { decodeStandaloneText, decodeStandaloneWasm, getStandaloneAssets } from '../standalone';
import { LoadRequestGate, copySnapshotForUi } from './coordination';
import type { Snapshot, WorkletCommand, WorkletEvent } from './protocol';

export type EngineState = 'idle' | 'initializing' | 'ready' | 'loading' | 'playing' | 'paused' | 'interrupted' | 'failed' | 'disposed';

export type EngineEvents = {
  ready: Extract<WorkletEvent, { type: 'ready' }>;
  loaded: Extract<WorkletEvent, { type: 'loaded' }>;
  state: Extract<WorkletEvent, { type: 'state' }>;
  snapshot: Snapshot;
  error: Extract<WorkletEvent, { type: 'error' }>;
  status: { state: EngineState; contextState: AudioContextState | 'closed' };
};

type Listener<K extends keyof EngineEvents> = (event: EngineEvents[K]) => void;
type LoadWaiter = { resolve: (generation: number) => void; reject: (reason: Error) => void };
const initializationTimeoutMs = 15_000;

const errorDetails = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message }
  : { name: typeof error, message: String(error) };

const loadAudioWorklet = async (context: AudioContext) => {
  const standaloneAssets = getStandaloneAssets();
  if (!standaloneAssets) {
    try {
      await context.audioWorklet.addModule(workletUrl);
      return;
    } catch (error) {
      console.error('SPC AudioWorklet module load failed.', {
        stage: 'worklet-module',
        source: 'built asset',
        protocol: location.protocol,
        secureContext: isSecureContext,
        standalone: false,
        error: errorDetails(error),
      });
      throw new Error('The audio processor could not be loaded. Reload the page and try again.');
    }
  }

  const dataUrl = `data:text/javascript;base64,${standaloneAssets.workletBase64}`;
  const blobUrl = URL.createObjectURL(new Blob([
    decodeStandaloneText(standaloneAssets.workletBase64),
  ], { type: 'text/javascript' }));
  const attempts = location.protocol === 'file:'
    ? [{ source: 'embedded data URL', url: dataUrl }, { source: 'embedded Blob URL', url: blobUrl }]
    : [{ source: 'embedded Blob URL', url: blobUrl }, { source: 'embedded data URL', url: dataUrl }];

  try {
    for (const attempt of attempts) {
      try {
        await context.audioWorklet.addModule(attempt.url);
        return;
      } catch (error) {
        console.error('SPC standalone AudioWorklet module load failed.', {
          stage: 'worklet-module',
          source: attempt.source,
          protocol: location.protocol,
          secureContext: isSecureContext,
          standalone: true,
          error: errorDetails(error),
        });
      }
    }
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  throw new Error(
    location.protocol === 'file:'
      ? 'This browser could not start audio from the standalone HTML file. Try a current Chromium-based browser or use the local launcher.'
      : 'The embedded audio processor could not start in this browser.',
  );
};

export class SpcAudioEngine {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private initializePromise: Promise<void> | null = null;
  private initializationFailure: ((error: Error) => void) | null = null;
  private listeners = new Map<keyof EngineEvents, Set<(event: never) => void>>();
  private loads = new LoadRequestGate();
  private requestId = 0;
  private commandId = 0;
  private loadWaiters = new Map<number, LoadWaiter>();
  private requestedVolume = 0.8;
  private disposed = false;
  private engineState: EngineState = 'idle';
  private stateBeforeInterruption: EngineState = 'paused';

  get sampleRate() { return this.context?.sampleRate ?? 0; }
  get contextState() { return this.context?.state ?? 'closed'; }
  get state() { return this.engineState; }
  get committedLoad() { return this.loads.committed; }

  on<K extends keyof EngineEvents>(type: K, listener: Listener<K>) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(type, set);
    return () => set.delete(listener as (event: never) => void);
  }

  reserveLoad() {
    const loadId = this.loads.begin();
    for (const [id, waiter] of this.loadWaiters) {
      if (id < loadId) {
        waiter.reject(new Error('Superseded by a newer selection'));
        this.loadWaiters.delete(id);
      }
    }
    return loadId;
  }

  isCurrentLoad(loadId: number) { return this.loads.isCurrent(loadId); }

  beginUserGesture() {
    const initialized = this.initialize();
    const resumed = this.resume();
    return Promise.all([initialized, resumed]).then(() => undefined);
  }

  async initialize() {
    if (this.disposed) throw new Error('The audio engine has been disposed');
    if (!this.initializePromise) {
      this.setEngineState('initializing');
      this.initializePromise = this.initializeOnce().catch(async (error) => {
        await this.cleanupPartialInitialization();
        this.initializePromise = null;
        if (!this.disposed) this.setEngineState('failed');
        throw error;
      });
    }
    return this.initializePromise;
  }

  private async initializeOnce() {
    const standaloneAssets = getStandaloneAssets();
    if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') {
      throw new Error(standaloneAssets
        ? 'This browser does not support the audio system required by the standalone player.'
        : 'Audio playback requires HTTPS or localhost in a browser with AudioWorklet support.');
    }
    const context = new AudioContext({ latencyHint: 'interactive' });
    this.context = context;
    if (!context.audioWorklet) {
      throw new Error(standaloneAssets
        ? 'This browser does not allow AudioWorklet playback from this local HTML file.'
        : 'AudioWorklet is unavailable. Open the app over HTTPS or localhost.');
    }
    context.onstatechange = () => {
      if (context.state === 'suspended' && (this.engineState === 'playing' || this.engineState === 'paused')) {
        this.stateBeforeInterruption = this.engineState;
        this.setEngineState('interrupted');
      }
      this.emitStatus();
    };
    await loadAudioWorklet(context);
    if (this.disposed) throw new Error('The audio engine was disposed during startup');
    const node = new AudioWorkletNode(context, 'spc-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
    });
    this.node = node;
    node.port.onmessage = (event: MessageEvent<WorkletEvent>) => this.handleEvent(event.data);
    node.onprocessorerror = () => this.failAll('The audio processor stopped unexpectedly');
    node.connect(context.destination);

    let bytes: ArrayBuffer;
    if (standaloneAssets) {
      bytes = decodeStandaloneWasm(standaloneAssets.wasmBase64);
    } else {
      const response = await fetch(new URL('spc_core.wasm', document.baseURI));
      if (!response.ok || (response.headers.get('content-type') || '').includes('text/html')) {
        throw new Error('Could not load the SPC audio core');
      }
      bytes = await response.arrayBuffer();
    }
    if (this.disposed) throw new Error('The audio engine was disposed during startup');
    const ready = new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        stopReady();
        stopError();
        this.initializationFailure = null;
        error ? reject(error) : resolve();
      };
      const timer = window.setTimeout(() => finish(new Error('The audio processor did not start in time')), initializationTimeoutMs);
      const stopReady = this.on('ready', () => finish());
      const stopError = this.on('error', (event) => event.fatal !== false && finish(new Error(event.message)));
      this.initializationFailure = (error) => finish(error);
    });
    this.post({ type: 'wasm', bytes }, [bytes]);
    await ready;
    this.post({ type: 'volume', gain: this.requestedVolume });
    this.setEngineState('ready');
  }

  async loadFile(file: File, paused = false, reservedLoadId?: number, activation?: Promise<void>) {
    const loadId = reservedLoadId ?? this.reserveLoad();
    if (!this.loads.isCurrent(loadId)) throw new Error('Superseded by a newer selection');
    if (file.size > 16 * 1024 * 1024) throw new Error('SPC files must be 16 MiB or smaller');
    this.setEngineState('loading');
    const bytesPromise = file.arrayBuffer();
    await Promise.all([activation ?? this.initialize(), bytesPromise]);
    if (!this.loads.isCurrent(loadId)) throw new Error('Superseded by a newer selection');
    const bytes = await bytesPromise;
    if (!this.loads.isCurrent(loadId)) throw new Error('Superseded by a newer selection');
    const completed = new Promise<number>((resolve, reject) => this.loadWaiters.set(loadId, { resolve, reject }));
    this.post({ type: 'load', loadId, bytes, paused }, [bytes]);
    return completed;
  }

  async resume() {
    const context = this.context;
    if (context && context.state !== 'running') await context.resume();
    if (context?.state === 'running' && this.engineState === 'interrupted') this.setEngineState(this.stateBeforeInterruption);
  }

  setPaused(paused: boolean) {
    if (!paused) void this.resume().catch((error) => this.emit('error', { type: 'error', fatal: false, message: String(error) }));
    const commandId = ++this.commandId;
    this.post({ type: 'pause', commandId, paused });
    return commandId;
  }

  restart() {
    const loadId = this.reserveLoad();
    const completed = new Promise<number>((resolve, reject) => this.loadWaiters.set(loadId, { resolve, reject }));
    this.post({ type: 'restart', loadId });
    return completed;
  }

  setVolume(gain: number) {
    this.requestedVolume = Math.min(1, Math.max(0, gain));
    this.post({ type: 'volume', gain: this.requestedVolume });
  }

  setView(mode: AramMode, hz: number, displaySync = false) {
    this.requestId += 1;
    const snapshotHz = Number.isFinite(hz) && hz > 0 ? hz : 60;
    this.post({ type: 'view', requestId: this.requestId, mode, hz: snapshotHz, displaySync });
    return this.requestId;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.initializationFailure?.(new Error('The audio engine was disposed'));
    this.failWaiters(new Error('The audio engine was disposed'));
    await this.cleanupPartialInitialization();
    this.setEngineState('disposed');
  }

  private async cleanupPartialInitialization() {
    const node = this.node;
    const context = this.context;
    this.node = null;
    this.context = null;
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  }

  private post(command: WorkletCommand, transfer: Transferable[] = []) {
    this.node?.port.postMessage(command, transfer);
  }

  private handleEvent(event: WorkletEvent) {
    if (event.type === 'loaded') {
      if (!this.loads.commit(event.loadId, event.generation)) return;
      this.loadWaiters.get(event.loadId)?.resolve(event.generation);
      this.loadWaiters.delete(event.loadId);
      this.setEngineState(event.paused ? 'paused' : 'playing');
    }
    if (event.type === 'state') this.setEngineState(event.playing ? 'playing' : 'paused');
    if (event.type === 'error' && event.loadId !== undefined) {
      if (!this.loads.isCurrent(event.loadId)) return;
      this.loadWaiters.get(event.loadId)?.reject(new Error(event.message));
      this.loadWaiters.delete(event.loadId);
    }
    if (event.type === 'error' && event.fatal) {
      this.failWaiters(new Error(event.message));
      this.setEngineState('failed');
    }
    if (event.type === 'snapshot') {
      const owned = copySnapshotForUi(event);
      this.recycle(event.payload);
      this.emit('snapshot', owned);
      return;
    }
    this.emit(event.type, event as never);
  }

  private failAll(message: string) {
    this.failWaiters(new Error(message));
    this.setEngineState('failed');
    this.emit('error', { type: 'error', fatal: true, message });
  }

  private failWaiters(error: Error) {
    for (const waiter of this.loadWaiters.values()) waiter.reject(error);
    this.loadWaiters.clear();
  }

  private recycle(buffer: ArrayBuffer) { this.post({ type: 'recycle', buffer }, [buffer]); }
  private setEngineState(state: EngineState) { this.engineState = state; this.emitStatus(); }
  private emitStatus() { this.emit('status', { state: this.engineState, contextState: this.contextState }); }
  private emit<K extends keyof EngineEvents>(type: K, event: EngineEvents[K]) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}
