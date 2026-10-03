import { ACTIVITY_BYTES, ARAM_BYTES, SNAPSHOT_BYTES, STATE_BYTES, type Snapshot } from '../audio/protocol';
export const HISTORY_SECONDS = 10;
export const HISTORY_FRAMES = HISTORY_SECONDS * 32000;
export const HISTORY_RECORD_BYTES = SNAPSHOT_BYTES + ACTIVITY_BYTES;
export type HistoryRecord = {
  id: number; generation: number; requestId: number; sequence: number;
  audibleFrame: number; nativeFrame: number; intervalStartFrame: number | null;
  previousId: number | null; continuous: boolean; payload: Uint8Array; combinedActivity: Uint8Array;
};

type HistoryStorage = Pick<HistoryRecord, 'payload' | 'combinedActivity'>;
// Returned records borrow recycled storage. Retain IDs, not payload views, across accepts.
export class MemoryHistory {
  // Map insertion order is the chronological queue, without a growing array head.
  private byId = new Map<number, HistoryRecord>();
  private reusable: HistoryStorage[] = [];
  private nextId = 1;
  private generation = 0;
  private sequence = -1;
  private discontinuity = -1;
  private newest: HistoryRecord | null = null;
  private readonly capacity: number;
  error = '';
  constructor(capacity?: number) {
    this.capacity = capacity === undefined ? Infinity : Math.max(2, Math.floor(capacity));
  }
  get count() { return this.byId.size; }
  get payloadBytes() { return (this.byId.size + this.reusable.length) * HISTORY_RECORD_BYTES; }
  reset(generation: number) {
    this.byId.clear(); this.reusable = []; this.newest = null;
    this.generation = generation; this.sequence = -1; this.discontinuity = -1; this.error = '';
  }
  latest() { return this.newest; }
  get(id: number) { return this.byId.get(id) ?? null; }
  previous(record: HistoryRecord) { return record.continuous && record.previousId !== null ? this.get(record.previousId) : null; }
  *records(): Iterable<HistoryRecord> {
    yield* this.byId.values();
  }
  private evict(record: HistoryRecord) {
    this.byId.delete(record.id);
    // Keep a small reserve for fractional cadence jitter; release excess buffers
    // when the capture rate falls rather than holding its peak allocation forever.
    if (this.reusable.length < 2) this.reusable.push({ payload: record.payload, combinedActivity: record.combinedActivity });
  }
  private trim(frame: number) {
    const cutoff = frame - HISTORY_FRAMES;
    while (this.byId.size >= 2) {
      const iterator = this.byId.values();
      const oldest = iterator.next().value!, second = iterator.next().value!;
      // Retain the sample at/before the cutoff as the first visible XOR baseline.
      // Keep the latest predecessor even across gaps, for the Map consumers.
      if (this.byId.size < this.capacity && second.audibleFrame > cutoff) break;
      this.evict(oldest);
    }
  }
  accept(snapshot: Snapshot, discontinuities: number): boolean {
    if (snapshot.generation !== this.generation || snapshot.sequence <= this.sequence) return false;
    if (snapshot.payload.byteLength !== SNAPSHOT_BYTES || !Number.isFinite(snapshot.audibleFrame) || snapshot.audibleFrame < 0) {
      this.error = 'The memory snapshot is invalid.'; return false;
    }
    const state = new DataView(snapshot.payload, ARAM_BYTES + ACTIVITY_BYTES, STATE_BYTES);
    const nativeFrame = state.getFloat64(24, true);
    if (state.getUint32(0, true) !== 1 || state.getUint32(4, true) !== STATE_BYTES || state.getUint32(8, true) !== this.generation || !Number.isFinite(nativeFrame) || nativeFrame < 0) {
      this.error = 'The memory snapshot state is invalid.'; return false;
    }
    if (this.newest && snapshot.audibleFrame < this.newest.audibleFrame) this.reset(this.generation);
    this.sequence = snapshot.sequence;
    if (this.newest?.audibleFrame === snapshot.audibleFrame) return false;
    const previous = this.newest;
    const continuous = previous !== null && previous.requestId === snapshot.requestId && this.discontinuity === discontinuities && snapshot.audibleFrame - previous.audibleFrame <= 8000;
    this.trim(snapshot.audibleFrame);
    let slot = this.reusable.pop();
    if (!slot) {
      try {
        const storage = new Uint8Array(HISTORY_RECORD_BYTES);
        slot = { payload: storage.subarray(0, SNAPSHOT_BYTES), combinedActivity: storage.subarray(SNAPSHOT_BYTES) };
      } catch {
        this.error = 'Waterfall history storage is full. Retained time may be shorter; Map and audio remain available.';
        if (this.byId.size < 2) return false;
        this.evict(this.byId.values().next().value!); slot = this.reusable.pop()!;
      }
    }
    const record: HistoryRecord = {
      id: this.nextId++, generation: snapshot.generation, requestId: snapshot.requestId, sequence: snapshot.sequence,
      audibleFrame: snapshot.audibleFrame, nativeFrame, intervalStartFrame: continuous ? previous!.audibleFrame : null,
      previousId: continuous ? previous!.id : null, continuous, payload: slot.payload, combinedActivity: slot.combinedActivity,
    };
    record.payload.set(new Uint8Array(snapshot.payload));
    record.combinedActivity.set(snapshot.combinedActivity ?? new Uint8Array(snapshot.payload, ARAM_BYTES, ACTIVITY_BYTES));
    this.byId.set(record.id, record); this.newest = record;
    this.discontinuity = discontinuities;
    return true;
  }
}
