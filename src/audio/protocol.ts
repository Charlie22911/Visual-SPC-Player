import type { AramMode } from '../aram/renderer';

export const ARAM_BYTES = 65536;
export const ACTIVITY_BYTES = 24576;
export const STATE_BYTES = 288;
export const SNAPSHOT_BYTES = ARAM_BYTES + ACTIVITY_BYTES + STATE_BYTES;

export type WorkletCommand =
  | { type: 'wasm'; bytes: ArrayBuffer }
  | { type: 'load'; loadId: number; bytes: ArrayBuffer; paused: boolean }
  | { type: 'pause'; commandId: number; paused: boolean }
  | { type: 'restart'; loadId: number }
  | { type: 'volume'; gain: number }
  | { type: 'view'; requestId: number; mode: AramMode; hz: number; displaySync?: boolean }
  | { type: 'recycle'; buffer: ArrayBuffer };

export type WorkletEvent =
  | { type: 'ready'; sampleRate: number; abiVersion: number }
  | { type: 'loaded'; loadId: number; generation: number; paused: boolean }
  | { type: 'state'; commandId?: number; playing: boolean; paused: boolean; generation: number; audibleFrame: number; droppedSnapshots: number }
  | { type: 'snapshot'; generation: number; requestId: number; sequence: number; audibleFrame: number; payload: ArrayBuffer }
  | { type: 'error'; loadId?: number; fatal?: boolean; message: string };

// Presentation-only access union. The worklet payload retains the original
// activity captured together with ARAM; it is never overwritten by coalescing.
export type Snapshot = Extract<WorkletEvent, { type: 'snapshot' }> & { combinedActivity?: Uint8Array };
