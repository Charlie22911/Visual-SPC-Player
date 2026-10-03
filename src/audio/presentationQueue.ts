import { ACTIVITY_BYTES, ARAM_BYTES, type Snapshot } from './protocol';

// Audio callbacks can arrive in bursts. Keep their intermediate states and
// present them using the audio timeline, one display frame behind arrival.
export class PresentationQueue {
  private pending: Snapshot[] = [];
  private anchorFrame = 0;
  private anchorTime = 0;
  private lastArrival = -Infinity;
  private generation = -1;
  private requestId = -1;
  private lastSequence = -1;
  private presentationDelayMs = 1000 / 60;
  combined = 0;
  overflows = 0;
  discontinuities = 0;

  clear() {
    if (this.pending.length) this.discontinuities += 1;
    this.pending = [];
    this.lastArrival = -Infinity;
    this.lastSequence = -1;
  }

  setDisplayFrameDuration(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    const next = Math.min(100, Math.max(1, milliseconds));
    const difference = next - this.presentationDelayMs;
    this.presentationDelayMs = next;
    if (this.generation !== -1) this.anchorTime += difference;
  }

  enqueue(snapshot: Snapshot, now: number) {
    const changed = snapshot.generation !== this.generation || snapshot.requestId !== this.requestId;
    if (changed || now - this.lastArrival > 100) {
      this.clear();
      this.anchorFrame = snapshot.audibleFrame;
      this.anchorTime = now + this.presentationDelayMs;
      this.generation = snapshot.generation;
      this.requestId = snapshot.requestId;
    }
    if (snapshot.sequence <= this.lastSequence) return;
    this.lastSequence = snapshot.sequence;
    this.lastArrival = now;
    // Re-anchor after a sustained scheduling stall or clock drift. Never try
    // to catch up by drawing a large backlog in one browser callback.
    const due = this.anchorTime + (snapshot.audibleFrame - this.anchorFrame) / 32;
    if (Math.abs(due - (now + this.presentationDelayMs)) > 80) {
      if (this.pending.length) this.discontinuities += 1;
      this.pending = [];
      this.anchorFrame = snapshot.audibleFrame;
      this.anchorTime = now + this.presentationDelayMs;
    }
    this.pending.push(snapshot);
    if (this.pending.length > 128) {
      this.discontinuities += 1;
      this.overflows += this.pending.length - 1;
      this.pending = [snapshot];
      this.anchorFrame = snapshot.audibleFrame;
      this.anchorTime = now + this.presentationDelayMs;
    }
  }

  take(now: number): Snapshot | null {
    let count = 0;
    while (count < this.pending.length) {
      const due = this.anchorTime + (this.pending[count].audibleFrame - this.anchorFrame) / 32;
      if (due > now) break;
      count += 1;
    }
    if (!count) return null;
    const next = this.pending[count - 1];
    if (count > 1) {
      const activity = new Uint8Array(next.payload, ARAM_BYTES, ACTIVITY_BYTES).slice();
      for (let index = 0; index < count - 1; index += 1) {
        const previous = new Uint8Array(this.pending[index].payload, ARAM_BYTES, ACTIVITY_BYTES);
        for (let byte = 0; byte < ACTIVITY_BYTES; byte += 1) activity[byte] |= previous[byte];
      }
      this.combined += count - 1;
      next.combinedActivity = activity;
    }
    this.pending.splice(0, count);
    return next;
  }
}
