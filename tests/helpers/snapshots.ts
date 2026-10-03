import { ACTIVITY_BYTES, ARAM_BYTES, SNAPSHOT_BYTES, STATE_BYTES, type Snapshot } from '../../src/audio/protocol';
export function makeSnapshot(sequence: number, options: { generation?: number; requestId?: number; frame?: number; nativeFrame?: number; ram?: (ram: Uint8Array) => void; activity?: (read: Uint8Array, write: Uint8Array, execute: Uint8Array) => void } = {}): Snapshot {
  const payload = new ArrayBuffer(SNAPSHOT_BYTES);
  const generation = options.generation ?? 1;
  const audibleFrame = options.frame ?? sequence * 3200;
  const state = new DataView(payload, ARAM_BYTES + ACTIVITY_BYTES);
  state.setUint32(0, 1, true); state.setUint32(4, STATE_BYTES, true); state.setUint32(8, generation, true); state.setUint32(12, sequence, true); state.setFloat64(24, options.nativeFrame ?? audibleFrame, true);
  options.ram?.(new Uint8Array(payload, 0, ARAM_BYTES));
  options.activity?.(new Uint8Array(payload, ARAM_BYTES, 8192), new Uint8Array(payload, ARAM_BYTES + 8192, 8192), new Uint8Array(payload, ARAM_BYTES + 16384, 8192));
  return { type: 'snapshot', sequence, generation, requestId: options.requestId ?? 1, audibleFrame, payload };
}
