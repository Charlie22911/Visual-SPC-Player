import type { Snapshot } from './protocol';

export class LoadRequestGate {
  private nextLoadId = 0;
  requested = 0;
  committed: { loadId: number; generation: number } | null = null;

  begin() {
    this.requested = ++this.nextLoadId;
    return this.requested;
  }

  isCurrent(loadId: number) {
    return loadId === this.requested;
  }

  commit(loadId: number, generation: number) {
    if (!this.isCurrent(loadId)) return false;
    this.committed = { loadId, generation };
    return true;
  }
}

export const copySnapshotForUi = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  payload: snapshot.payload.slice(0),
  combinedActivity: snapshot.combinedActivity?.slice(),
});
