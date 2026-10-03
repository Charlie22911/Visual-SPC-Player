import { StreamingSincResampler } from './resampler';
import {
  ACTIVITY_BYTES,
  ARAM_BYTES,
  SNAPSHOT_BYTES,
  STATE_BYTES,
  type WorkletCommand,
  type WorkletEvent,
} from './protocol';

declare const sampleRate: number;
declare const registerProcessor: (name: string, constructor: typeof AudioWorkletProcessor) => void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}

type WasmExports = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(bytes: number): number;
  free(pointer: number): void;
  web_spc_abi_version(): number;
  web_spc_init(): number;
  web_spc_prepare(pointer: number, bytes: number, clearEcho: number): number;
  web_spc_commit_prepared(): number;
  web_spc_render(pointer: number, frames: number): number;
  web_spc_copy_aram(pointer: number, capacity: number): number;
  web_spc_take_activity(pointer: number, capacity: number): number;
  web_spc_copy_state(pointer: number, capacity: number): number;
  web_spc_generated_frames(): number;
  web_spc_generation(): number;
  web_spc_dispose(): void;
};

const NATIVE_RATE = 32000;
const RENDER_FRAMES = 512;
const RAMP_SECONDS = 0.008;
const MAX_SPC_BYTES = 16 * 1024 * 1024;
type PendingLoad = { bytes: Uint8Array; loadId: number; paused: boolean };

class SpcProcessor extends AudioWorkletProcessor {
  private wasm: WasmExports | null = null;
  private resampler: StreamingSincResampler | null = null;
  private renderPointer = 0;
  private aramPointer = 0;
  private activityPointer = 0;
  private statePointer = 0;
  private trackBytes: Uint8Array | null = null;
  private playing = false;
  private paused = true;
  private volume = 0.8;
  private gain = 0;
  private targetGain = 0;
  private rampRemaining = 0;
  private requestId = 0;
  private snapshotHz = 30;
  private displaySync = false;
  private snapshotClock = 0;
  private stateClock = 0;
  private audibleFrame = 0;
  private snapshotPool: ArrayBuffer[] = [];
  private droppedSnapshots = 0;
  private latestLoadId = 0;
  private pendingLoad: PendingLoad | null = null;
  private pendingPauseCommandId: number | null = null;
  private renderFailed = false;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.port.onmessage = (event: MessageEvent<WorkletCommand>) => this.handle(event.data);
  }

  private post(event: WorkletEvent, transfer: Transferable[] = []) {
    this.port.postMessage(event, transfer);
  }

  private handle(command: WorkletCommand) {
    switch (command.type) {
      case 'wasm':
        void this.initializeWasm(command.bytes);
        break;
      case 'load':
        this.prepareLoad(command.bytes, command.loadId, command.paused);
        break;
      case 'restart':
        if (this.trackBytes) {
          this.prepareLoad(this.trackBytes.slice().buffer, command.loadId, this.paused);
        } else {
          this.post({ type: 'error', loadId: command.loadId, fatal: false, message: 'No track is loaded' });
        }
        break;
      case 'pause':
        this.setPaused(command.paused, command.commandId);
        break;
      case 'volume':
        this.volume = Math.min(1, Math.max(0, command.gain));
        if (!this.paused && !this.pendingLoad) this.beginRamp(this.volume);
        break;
      case 'view':
        this.requestId = command.requestId;
        this.displaySync = command.displaySync === true;
        this.snapshotClock = 0;
        this.snapshotHz = Number.isFinite(command.hz) && command.hz > 0 ? command.hz : 60;
        if (this.trackBytes) this.publishSnapshot();
        break;
      case 'recycle':
        if (command.buffer.byteLength === SNAPSHOT_BYTES) this.snapshotPool.push(command.buffer);
        break;
    }
  }

  private async initializeWasm(bytes: ArrayBuffer) {
    let memory: WebAssembly.Memory | null = null;
    const wasi = {
      proc_exit: (code: number) => {
        throw new Error('SPC core exited with code ' + code);
      },
      fd_close: () => 0,
      fd_write: (_fd: number, _iov: number, _count: number, written: number) => {
        if (memory && written) new DataView(memory.buffer).setUint32(written, 0, true);
        return 0;
      },
      fd_seek: (_fd: number, _offset: bigint, _whence: number, result: number) => {
        if (memory && result) new DataView(memory.buffer).setBigUint64(result, 0n, true);
        return 0;
      },
    };
    try {
      const compiled = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
      const exports = compiled.instance.exports as unknown as WasmExports;
      memory = exports.memory;
      exports._initialize();
      if (exports.web_spc_abi_version() !== 1 || exports.web_spc_init() !== 0) {
        throw new Error('The SPC WebAssembly ABI could not initialize');
      }
      this.wasm = exports;
      this.resampler = new StreamingSincResampler(NATIVE_RATE, sampleRate);
      this.renderPointer = exports.malloc(RENDER_FRAMES * 2 * Int16Array.BYTES_PER_ELEMENT);
      this.aramPointer = exports.malloc(ARAM_BYTES);
      this.activityPointer = exports.malloc(ACTIVITY_BYTES);
      this.statePointer = exports.malloc(STATE_BYTES);
      if (!this.renderPointer || !this.aramPointer || !this.activityPointer || !this.statePointer) {
        throw new Error('The SPC audio buffers could not be allocated');
      }
      this.snapshotPool = Array.from({ length: 16 }, () => new ArrayBuffer(SNAPSHOT_BYTES));
      this.post({ type: 'ready', sampleRate, abiVersion: 1 });
    } catch (error) {
      this.post({ type: 'error', fatal: true, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private prepareLoad(bytes: ArrayBuffer, loadId: number, paused: boolean) {
    if (loadId <= this.latestLoadId) {
      this.post({ type: 'error', loadId, fatal: false, message: 'Superseded by a newer selection' });
      return;
    }
    this.latestLoadId = loadId;
    const wasm = this.wasm;
    if (!wasm) {
      this.failLoad(loadId, 'Audio engine is not ready');
      return;
    }
    if (bytes.byteLength < 0x10180 || bytes.byteLength > MAX_SPC_BYTES) {
      this.failLoad(loadId, 'This is not a supported SPC file');
      return;
    }
    const pointer = wasm.malloc(bytes.byteLength);
    if (!pointer) {
      this.failLoad(loadId, 'The SPC file could not be staged');
      return;
    }
    new Uint8Array(wasm.memory.buffer, pointer, bytes.byteLength).set(new Uint8Array(bytes));
    const prepared = wasm.web_spc_prepare(pointer, bytes.byteLength, 1);
    wasm.free(pointer);
    if (prepared !== 0) {
      this.failLoad(loadId, 'The SPC emulator rejected this file');
      return;
    }
    this.pendingLoad = { bytes: new Uint8Array(bytes).slice(), loadId, paused };
    if (this.playing && this.gain > 0) {
      this.beginRamp(0);
      return;
    }
    this.commitPendingLoad();
  }

  private commitPendingLoad() {
    const wasm = this.wasm;
    const pending = this.pendingLoad;
    if (!wasm || !pending) return;
    if (pending.loadId !== this.latestLoadId || wasm.web_spc_commit_prepared() !== 0) {
      this.failLoad(pending.loadId, 'The SPC emulator could not commit this file');
      return;
    }
    this.pendingLoad = null;
    this.trackBytes = pending.bytes;
    this.resampler?.reset();
    this.audibleFrame = 0;
    this.snapshotClock = 0;
    this.renderFailed = false;
    this.paused = pending.paused;
    this.playing = !pending.paused;
    this.gain = 0;
    this.targetGain = 0;
    this.rampRemaining = 0;
    if (!pending.paused) this.beginRamp(this.volume);
    this.post({
      type: 'loaded',
      loadId: pending.loadId,
      generation: wasm.web_spc_generation(),
      paused: pending.paused,
    });
    const pauseCommandId = pending.paused ? this.pendingPauseCommandId ?? undefined : undefined;
    this.pendingPauseCommandId = null;
    this.publishState(pauseCommandId);
    this.publishSnapshot();
  }

  private setPaused(paused: boolean, commandId: number) {
    if (this.pendingLoad) this.pendingLoad.paused = paused;
    if (!this.trackBytes || this.paused === paused) {
      this.publishState(commandId);
      return;
    }
    this.paused = paused;
    if (paused) {
      this.pendingPauseCommandId = commandId;
      this.beginRamp(0);
    } else {
      this.pendingPauseCommandId = null;
      this.playing = true;
      this.beginRamp(this.volume);
      this.publishState(commandId);
    }
  }

  private publishState(commandId?: number) {
    this.post({
      type: 'state', commandId, playing: this.playing, paused: this.paused,
      generation: this.wasm?.web_spc_generation() ?? 0, audibleFrame: this.audibleFrame,
      droppedSnapshots: this.droppedSnapshots,
    });
  }

  private failLoad(loadId: number, message: string) {
    if (this.pendingLoad && this.pendingLoad.loadId <= loadId) this.pendingLoad = null;
    if (this.trackBytes && !this.paused) {
      this.playing = true;
      this.beginRamp(this.volume);
    }
    this.post({ type: 'error', loadId, fatal: false, message });
  }

  private beginRamp(target: number) {
    this.targetGain = target;
    this.rampRemaining = Math.max(128, Math.ceil(sampleRate * RAMP_SECONDS / 128) * 128);
  }

  private ensureInput(outputFrames: number) {
    const wasm = this.wasm;
    const resampler = this.resampler;
    if (!wasm || !resampler) return false;
    // RENDER_FRAMES is capacity, not a fixed 16 ms emulation step.
    while (resampler.neededInputFrames(outputFrames) > 0) {
      const frames = Math.min(RENDER_FRAMES, resampler.neededInputFrames(outputFrames));
      if (wasm.web_spc_render(this.renderPointer, frames) !== 0) return false;
      const samples = new Int16Array(wasm.memory.buffer, this.renderPointer, frames * 2);
      resampler.push(samples);
    }
    return true;
  }

  private publishSnapshot() {
    const wasm = this.wasm;
    if (!wasm || this.snapshotPool.length === 0) {
      this.droppedSnapshots += 1;
      return;
    }
    const payload = this.snapshotPool.pop() as ArrayBuffer;
    if (
      wasm.web_spc_copy_aram(this.aramPointer, ARAM_BYTES) !== 0 ||
      wasm.web_spc_take_activity(this.activityPointer, ACTIVITY_BYTES) !== 0 ||
      wasm.web_spc_copy_state(this.statePointer, STATE_BYTES) !== 0
    ) {
      this.snapshotPool.push(payload);
      return;
    }
    const destination = new Uint8Array(payload);
    destination.set(new Uint8Array(wasm.memory.buffer, this.aramPointer, ARAM_BYTES), 0);
    destination.set(new Uint8Array(wasm.memory.buffer, this.activityPointer, ACTIVITY_BYTES), ARAM_BYTES);
    destination.set(
      new Uint8Array(wasm.memory.buffer, this.statePointer, STATE_BYTES),
      ARAM_BYTES + ACTIVITY_BYTES,
    );
    const state = new DataView(payload, ARAM_BYTES + ACTIVITY_BYTES, STATE_BYTES);
    this.post(
      {
        type: 'snapshot',
        generation: state.getUint32(8, true),
        requestId: this.requestId,
        sequence: state.getUint32(12, true),
        audibleFrame: this.audibleFrame,
        payload,
      },
      [payload],
    );
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output[1] ?? output[0];
    left.fill(0);
    if (right !== left) right.fill(0);
    if (!this.playing || !this.resampler) return true;
    if (!this.ensureInput(left.length)) {
      if (!this.renderFailed) {
        this.renderFailed = true;
        this.playing = false;
        this.paused = true;
        this.post({ type: 'error', fatal: true, message: 'The SPC emulator stopped while rendering audio' });
        this.publishState();
      }
      return true;
    }

    const produced = this.resampler.read(left, right);
    for (let index = 0; index < produced; index += 1) {
      if (this.rampRemaining > 0) {
        this.gain += (this.targetGain - this.gain) / this.rampRemaining;
        this.rampRemaining -= 1;
      } else {
        this.gain = this.targetGain;
      }
      left[index] *= this.gain;
      right[index] *= this.gain;
    }
    this.audibleFrame += (produced * NATIVE_RATE) / sampleRate;
    this.snapshotClock += produced;
    if (this.rampRemaining === 0 && this.gain === 0) {
      if (this.pendingLoad) {
        this.commitPendingLoad();
      } else if (this.paused && this.playing) {
        this.playing = false;
        this.publishState(this.pendingPauseCommandId ?? undefined);
        this.pendingPauseCommandId = null;
      }
    }
    const interval = sampleRate / this.snapshotHz;
    if (this.displaySync || this.snapshotClock >= interval) {
      this.snapshotClock %= interval;
      this.publishSnapshot();
    }
    this.stateClock += produced;
    if (this.stateClock >= sampleRate / 10) {
      this.stateClock %= sampleRate / 10;
      this.publishState();
    }
    return true;
  }
}

registerProcessor('spc-processor', SpcProcessor);
