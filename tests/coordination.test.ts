import { describe, expect, test } from 'vitest';
import { LoadRequestGate, copySnapshotForUi } from '../src/audio/coordination';
import type { Snapshot } from '../src/audio/protocol';

describe('audio/UI ownership and ordering', () => {
  test('only the newest selection may commit', () => {
    const gate = new LoadRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    expect(gate.commit(first, 1)).toBe(false);
    expect(gate.commit(second, 2)).toBe(true);
    expect(gate.committed).toEqual({ loadId: second, generation: 2 });
  });

  test('UI snapshots remain readable after the transferable is recycled', () => {
    const transferable = new ArrayBuffer(8);
    new Uint8Array(transferable)[0] = 0xa5;
    const snapshot: Snapshot = {
      type: 'snapshot', generation: 4, requestId: 7, sequence: 9,
      audibleFrame: 10, payload: transferable,
    };
    const owned = copySnapshotForUi(snapshot);
    structuredClone(transferable, { transfer: [transferable] });
    expect(transferable.byteLength).toBe(0);
    expect(owned.payload.byteLength).toBe(8);
    expect(new Uint8Array(owned.payload)[0]).toBe(0xa5);
  });
});
