export type SpectrumSettings = {
  preset: 'balanced' | 'transient' | 'frequency' | 'raw' | 'custom';
  fftSize: 1024 | 2048 | 4096;
  hopSize: 64 | 128 | 256 | 512;
  sampling: 'nearest' | 'smooth' | 'area';
  seconds: 2 | 5 | 10;
  logarithmic: boolean;
  temporal: boolean;
  temporalMs: number;
  difference: boolean;
  palette: 'green' | 'heat' | 'grayscale';
  floorDb: number;
  ceilingDb: number;
};

/** Borrowed until the synchronous spectrum listener returns. Upload/copy immediately. */
export type SpectrumFrame = {
  epoch: number;
  generation: number;
  sequence: number;
  segment: number;
  /** Native 32 kHz window end, exclusive, before playback volume. */
  nativeFrame: number;
  bins: number;
  /** Interleaved stereo mean power and phase-sensitive (L-R)/2 power. */
  values: Float32Array;
};

export type SpectrumOptions = Pick<SpectrumSettings, 'fftSize' | 'hopSize'>;
export type SpectrumStats = {
  active: boolean; epoch: number; analysed: number; dropped: number;
  pcmDropped: number; packets: number; delivered: number; errors: number;
};

export const SPECTRUM_PACKET_FRAMES = 512;
export const SPECTRUM_PCM_CREDITS = 32;
export const SPECTRUM_RESULT_CREDITS = 32;
export type SpectrumPcmPacket = {
  type: 'pcm'; epoch: number; generation: number; nativeFrame: number;
  frames: number; discontinuity: number; dropped: number; buffer: ArrayBuffer;
};
/** The worker prepares the complete reusable envelope, including the typed view. */
export type SpectrumPcmCredit = {
  type: 'credit'; epoch: number; buffer: ArrayBuffer; samples: Int16Array;
  packet: SpectrumPcmPacket; transfer: ArrayBuffer[];
};
export type SpectrumWorkerCommand =
  | { type: 'init'; epoch: number; fftSize: number; hopSize: number; wasm: ArrayBuffer; port: MessagePort }
  | { type: 'recycle'; epoch: number; buffer: ArrayBuffer };
export type SpectrumWorkerEvent =
  | { type: 'ready'; epoch: number }
  | { type: 'frame'; epoch: number; generation: number; sequence: number; segment: number; nativeFrame: number; bins: number; buffer: ArrayBuffer }
  | { type: 'stats'; epoch: number; analysed: number; dropped: number; pcmDropped: number; packets: number }
  | { type: 'error'; epoch: number; message: string };
