import { ACTIVITY_BYTES, ARAM_BYTES, type Snapshot } from './protocol';
import { ByteRefreshMonitor } from './byteRefresh';

// Owned UI snapshots: never backed by a buffer returned to the worklet.
export class VisualStream {
  byteRefresh: ByteRefreshMonitor | null = null;
  latest: Snapshot | null = null;
  received = 0;
  fresh = 0;
  coalesced = 0;
  draws = 0;
  presented = 0;
  queueOverflows = 0;
  private nativeFrame = -1;
  private generation = -1;
  private listeners = new Set<(snapshot: Snapshot) => void>();

  receivedSnapshot(snapshot: Snapshot) {
    this.byteRefresh?.receive(snapshot);
    this.received += 1;
    const frame = new DataView(snapshot.payload, ARAM_BYTES + ACTIVITY_BYTES).getFloat64(24, true);
    if (this.generation !== snapshot.generation || frame !== this.nativeFrame) this.fresh += 1;
    this.nativeFrame = frame;
    this.generation = snapshot.generation;
  }

  publish(snapshot: Snapshot) {
    this.byteRefresh?.present(snapshot);
    this.latest = snapshot;
    this.presented += 1;
    for (const listener of this.listeners) listener(snapshot);
  }

  subscribe(listener: (snapshot: Snapshot) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setByteRefreshEnabled(enabled: boolean, now = performance.now()) {
    if (enabled && !this.byteRefresh) this.byteRefresh = new ByteRefreshMonitor(now);
    if (!enabled) this.byteRefresh = null;
  }
}
