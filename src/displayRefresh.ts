type DisplayRefreshTrackerOptions = {
  sampleSize?: number;
  minimumSamples?: number;
  maximumFrameIntervalMs?: number;
};

export class DisplayRefreshTracker {
  private readonly sampleSize: number;
  private readonly minimumSamples: number;
  private readonly maximumFrameIntervalMs: number;
  private lastTimestamp: number | null = null;
  private frameIntervals: number[] = [];

  constructor(options: DisplayRefreshTrackerOptions = {}) {
    this.sampleSize = Math.max(2, Math.round(options.sampleSize ?? 90));
    this.minimumSamples = Math.min(
      this.sampleSize,
      Math.max(2, Math.round(options.minimumSamples ?? 20)),
    );
    this.maximumFrameIntervalMs = Math.max(1, options.maximumFrameIntervalMs ?? 100);
  }

  addFrame(timestamp: number): number | null {
    if (!Number.isFinite(timestamp)) {
      this.reset();
      return null;
    }

    if (this.lastTimestamp === null) {
      this.lastTimestamp = timestamp;
      return null;
    }

    const interval = timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;
    if (interval <= 0 || interval > this.maximumFrameIntervalMs) {
      this.frameIntervals = [];
      return null;
    }

    this.frameIntervals.push(interval);
    if (this.frameIntervals.length > this.sampleSize) this.frameIntervals.shift();
    if (this.frameIntervals.length < this.minimumSamples) return null;

    const ordered = [...this.frameIntervals].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    const median = ordered.length % 2
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
    return Math.max(1, Math.round(1000 / median));
  }

  reset() {
    this.lastTimestamp = null;
    this.frameIntervals = [];
  }
}
