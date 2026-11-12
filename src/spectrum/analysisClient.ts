import AnalysisWorker from './analysis.worker.ts?worker&inline';
import { decodeStandaloneWasm, getStandaloneAssets } from '../standalone';
import type { SpectrumFrame, SpectrumOptions, SpectrumStats, SpectrumWorkerEvent } from './types';

let wasmBytes: Promise<ArrayBuffer> | null = null;
const loadWasm = () => wasmBytes ??= (async () => {
  const embedded = getStandaloneAssets()?.spectrumWasmBase64;
  if (embedded) return decodeStandaloneWasm(embedded);
  const response = await fetch(new URL('spc_spectrum.wasm', document.baseURI));
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error('Could not load the spectrum analyser');
  return response.arrayBuffer();
})().catch((error) => { wasmBytes = null; throw error; });

export class SpectrumAnalysisClient {
  private worker: Worker | null = null;
  private options: SpectrumOptions | null = null;
  private counters: SpectrumStats = { active: false, epoch: 0, analysed: 0, dropped: 0, pcmDropped: 0, packets: 0, delivered: 0, errors: 0 };
  constructor(private connect: (epoch: number, port: MessagePort | null) => void,
    private frame: (frame: SpectrumFrame) => void, private error: (message: string) => void) {}

  configure(options: SpectrumOptions | null) {
    if (options && this.options?.fftSize === options.fftSize && this.options.hopSize === options.hopSize) return;
    if (!options && !this.options) return;
    this.options = options ? { ...options } : null;
    const epoch = ++this.counters.epoch;
    this.connect(epoch, null);
    this.worker?.terminate();
    this.worker = null;
    this.counters.active = options !== null;
    if (options) {
      this.counters.analysed = this.counters.dropped = this.counters.pcmDropped = 0;
      this.counters.packets = this.counters.delivered = 0;
    }
    if (options) void this.start(epoch, options);
  }
  stats(): SpectrumStats { return { ...this.counters }; }
  dispose() { this.configure(null); }

  private async start(epoch: number, options: SpectrumOptions) {
    try {
      const bytes = (await loadWasm()).slice(0);
      if (epoch !== this.counters.epoch || !this.options) return;
      const worker = new AnalysisWorker();
      const channel = new MessageChannel();
      this.worker = worker;
      worker.onerror = () => this.fail(epoch, 'The spectrum analyser stopped unexpectedly');
      worker.onmessage = (event: MessageEvent<SpectrumWorkerEvent>) => {
        const result = event.data;
        if (result.epoch !== this.counters.epoch || this.worker !== worker) return;
        if (result.type === 'error') { this.fail(epoch, result.message); return; }
        if (result.type === 'stats') {
          this.counters.analysed = result.analysed;
          this.counters.dropped = result.dropped;
          this.counters.pcmDropped = result.pcmDropped;
          this.counters.packets = result.packets;
        }
        if (result.type !== 'frame') return;
        this.counters.analysed = Math.max(this.counters.analysed, result.sequence);
        ++this.counters.delivered;
        try {
          this.frame({ epoch: result.epoch, generation: result.generation, sequence: result.sequence,
            segment: result.segment, nativeFrame: result.nativeFrame, bins: result.bins, values: new Float32Array(result.buffer) });
        } finally {
          if (this.worker === worker) worker.postMessage({ type: 'recycle', epoch, buffer: result.buffer }, [result.buffer]);
        }
      };
      worker.postMessage({ type: 'init', epoch, ...options, wasm: bytes, port: channel.port1 }, [bytes, channel.port1]);
      this.connect(epoch, channel.port2);
    } catch (error) { this.fail(epoch, error instanceof Error ? error.message : String(error)); }
  }
  private fail(epoch: number, message: string) {
    if (epoch !== this.counters.epoch) return;
    ++this.counters.errors;
    this.configure(null);
    this.error(message);
  }
}
