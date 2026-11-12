import { SPECTRUM_PACKET_FRAMES, SPECTRUM_PCM_CREDITS, SPECTRUM_RESULT_CREDITS,
  type SpectrumPcmCredit, type SpectrumPcmPacket, type SpectrumWorkerCommand, type SpectrumWorkerEvent } from './types';

export type SpectrumWasmExports = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  spc_spectrum_configure(fft: number, hop: number): number;
  spc_spectrum_reset(): void;
  spc_spectrum_input(): number;
  spc_spectrum_output(): number;
  spc_spectrum_push(frames: number): number;
  spc_spectrum_offset(row: number): number;
};

/** Single-owner streaming adapter; all PCM and result payloads have fixed credits. */
export class SpectrumAnalysis {
  private generation = 0;
  private nextFrame = -1;
  private discontinuity = -1;
  private segment = 0;
  private sequence = 0;
  private analysed = 0;
  private dropped = 0;
  private packets = 0;
  private resultPool: ArrayBuffer[];
  private input: Int16Array;
  private output: Float32Array;
  private bins: number;
  constructor(private wasm: SpectrumWasmExports, private epoch: number, fft: number, hop: number,
    private emit: (event: SpectrumWorkerEvent, transfer: Transferable[]) => void) {
    if (wasm.spc_spectrum_configure(fft, hop) !== 0) throw new Error('Unsupported spectrum analysis configuration');
    this.bins = fft / 2 + 1;
    this.input = new Int16Array(wasm.memory.buffer, wasm.spc_spectrum_input(), SPECTRUM_PACKET_FRAMES * 2);
    this.output = new Float32Array(wasm.memory.buffer, wasm.spc_spectrum_output(), this.bins * 2 * 8);
    this.resultPool = Array.from({ length: SPECTRUM_RESULT_CREDITS }, () => new ArrayBuffer(this.bins * 2 * 4));
  }
  recycle(epoch: number, buffer: ArrayBuffer) {
    if (epoch === this.epoch && buffer.byteLength === this.bins * 2 * 4 && this.resultPool.length < SPECTRUM_RESULT_CREDITS) {
      this.resultPool.push(buffer);
    }
  }
  ingest(packet: SpectrumPcmPacket) {
    if (packet.epoch !== this.epoch || packet.generation < this.generation ||
      !Number.isSafeInteger(packet.nativeFrame) || packet.nativeFrame < 0 ||
      !Number.isInteger(packet.frames) || packet.frames < 1 || packet.frames > SPECTRUM_PACKET_FRAMES ||
      packet.buffer.byteLength !== SPECTRUM_PACKET_FRAMES * 2 * 2) return;
    if (packet.generation !== this.generation || this.nextFrame !== packet.nativeFrame || this.discontinuity !== packet.discontinuity) {
      this.wasm.spc_spectrum_reset();
      ++this.segment;
    }
    this.generation = packet.generation;
    this.discontinuity = packet.discontinuity;
    const pcm = new Int16Array(packet.buffer);
    // Copy only valid frames; the fixed input tail never participates in push.
    this.input.set(pcm.subarray(0, packet.frames * 2));
    const rows = this.wasm.spc_spectrum_push(packet.frames);
    this.nextFrame = packet.nativeFrame + packet.frames;
    for (let row = 0; row < rows; ++row) {
      ++this.analysed;
      const sequence = ++this.sequence;
      const buffer = this.resultPool.pop();
      if (!buffer) { ++this.dropped; continue; }
      new Float32Array(buffer).set(this.output.subarray(row * this.bins * 2, (row + 1) * this.bins * 2));
      this.emit({ type: 'frame', epoch: this.epoch, generation: this.generation, sequence,
        segment: this.segment, nativeFrame: packet.nativeFrame + this.wasm.spc_spectrum_offset(row), bins: this.bins, buffer }, [buffer]);
    }
    ++this.packets;
    // A bounded-rate report avoids an extra main-thread message for every FFT.
    if ((this.packets & 63) === 0) this.emit({ type: 'stats', epoch: this.epoch,
      analysed: this.analysed, dropped: this.dropped, pcmDropped: packet.dropped, packets: this.packets }, []);
  }
}

if (typeof document === 'undefined') {
  let analysis: SpectrumAnalysis | null = null;
  let epoch = 0;
  self.onmessage = async (event: MessageEvent<SpectrumWorkerCommand>) => {
    const command = event.data;
    if (command.type === 'recycle') { analysis?.recycle(command.epoch, command.buffer); return; }
    epoch = command.epoch;
    const emit = (value: SpectrumWorkerEvent, transfer: Transferable[] = []) => self.postMessage(value, { transfer });
    try {
      const result = await WebAssembly.instantiate(command.wasm, {
        wasi_snapshot_preview1: { proc_exit: (code: number) => { throw new Error(`Spectrum core exited: ${code}`); } },
      });
      if (epoch !== command.epoch) return;
      const wasm = result.instance.exports as unknown as SpectrumWasmExports;
      wasm._initialize();
      analysis = new SpectrumAnalysis(wasm, epoch, command.fftSize, command.hopSize, emit);
      const port = command.port;
      const credit = (buffer: ArrayBuffer) => {
        const value: SpectrumPcmCredit = { type: 'credit', epoch, buffer, samples: new Int16Array(buffer),
          packet: { type: 'pcm', epoch, generation: 0, nativeFrame: 0, frames: 0, discontinuity: 0, dropped: 0, buffer }, transfer: [buffer] };
        port.postMessage(value, value.transfer);
      };
      port.onmessage = (message: MessageEvent<SpectrumPcmPacket>) => {
        const packet = message.data;
        if (packet.type !== 'pcm') return;
        analysis?.ingest(packet);
        credit(packet.buffer);
      };
      for (let i = 0; i < SPECTRUM_PCM_CREDITS; ++i) {
        credit(new ArrayBuffer(SPECTRUM_PACKET_FRAMES * 2 * 2));
      }
      emit({ type: 'ready', epoch });
    } catch (error) {
      emit({ type: 'error', epoch, message: error instanceof Error ? error.message : String(error) });
    }
  };
}
