import { describe, expect, test } from 'vitest';
import { DisplayRefreshTracker } from '../src/displayRefresh';

describe('display refresh tracking', () => {
  test('detects a 240 Hz requestAnimationFrame cadence without capping it', () => {
    const tracker = new DisplayRefreshTracker({ sampleSize: 24, minimumSamples: 12 });
    let measured: number | null = null;

    for (let frame = 0; frame < 30; frame += 1) {
      measured = tracker.addFrame(frame * (1000 / 240)) ?? measured;
    }

    expect(measured).toBe(240);
  });

  test('drops old samples after a throttling gap and adapts to the new cadence', () => {
    const tracker = new DisplayRefreshTracker({ sampleSize: 20, minimumSamples: 10 });
    let timestamp = 0;
    let measured: number | null = null;

    for (let frame = 0; frame < 20; frame += 1) {
      measured = tracker.addFrame(timestamp) ?? measured;
      timestamp += 1000 / 120;
    }
    expect(measured).toBe(120);

    timestamp += 500;
    expect(tracker.addFrame(timestamp)).toBeNull();
    for (let frame = 0; frame < 20; frame += 1) {
      timestamp += 1000 / 240;
      measured = tracker.addFrame(timestamp) ?? measured;
    }

    expect(measured).toBe(240);
  });
});
