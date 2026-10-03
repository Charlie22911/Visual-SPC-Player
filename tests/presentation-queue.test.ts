import { expect, test } from 'vitest';
import { PresentationQueue } from '../src/audio/presentationQueue';
import { ARAM_BYTES } from '../src/audio/protocol';
import { makeSnapshot } from './helpers/snapshots';
test('coalescing ORs kinds without making a discontinuity', () => {
  const q = new PresentationQueue();
  q.enqueue(makeSnapshot(1, { frame: 0, activity: r => { r[0] = 1; } }), 0);
  const revision = q.discontinuities;
  q.enqueue(makeSnapshot(2, { frame: 128, activity: (_, w) => { w[0] = 2; } }), 4);
  const result = q.take(100)!; const activity = result.combinedActivity!;
  expect(activity[0]).toBe(1); expect(activity[8192]).toBe(2); expect(q.discontinuities).toBe(revision);
  const paired = new Uint8Array(result.payload, ARAM_BYTES);
  expect(paired[0]).toBe(0); expect(paired[8192]).toBe(2);
});
test('discarding queued snapshots signals a discontinuity', () => {
  const q = new PresentationQueue(); q.enqueue(makeSnapshot(1, { frame: 0 }), 0);
  const revision = q.discontinuities; q.clear(); expect(q.discontinuities).toBeGreaterThan(revision);
});
