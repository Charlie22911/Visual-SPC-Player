import { ACTIVITY_BYTES, ARAM_BYTES, type Snapshot } from './protocol';

type Counters = {
  snapshots: number; advanced: number; ramChanged: number; echoChanged: number;
  changedEchoBytes: number; writtenEchoAddresses: number; longestUnchangedEchoMs: number;
  wallGaps: number[]; audioGaps: number[];
};
export type ByteRefreshRates = Omit<Counters, 'wallGaps' | 'audioGaps'> & { wallGapMedian: number; wallGap95: number; audioGap95: number };
export type ByteRefreshMeasurement = {
  elapsedSeconds: number; recordedAt: string; received: ByteRefreshRates; presented: ByteRefreshRates;
  echoStart: number | null; echoLength: number; mode?: string; geometry?: string; target?: number | string;
};
type Previous = { snapshot: Snapshot; time: number; nativeFrame: number; echoStart: number; echoLength: number };
const counters = (): Counters => ({ snapshots: 0, advanced: 0, ramChanged: 0, echoChanged: 0, changedEchoBytes: 0, writtenEchoAddresses: 0, longestUnchangedEchoMs: 0, wallGaps: [], audioGaps: [] });
class Channel {
  values = counters();
  previous: Previous | null = null;
  unchangedSince: number | null = null;
  observe(snapshot: Snapshot, now: number, countWrites: boolean) {
    const bytes = new Uint8Array(snapshot.payload), state = new DataView(snapshot.payload, ARAM_BYTES + ACTIVITY_BYTES);
    const nativeFrame = state.getFloat64(24, true), dsp = ARAM_BYTES + ACTIVITY_BYTES + 32;
    const echoStart = bytes[dsp + 0x6d] * 256, echoLength = (bytes[dsp + 0x7d] & 15) * 2048 || 4;
    const previous = this.previous, values = this.values;
    values.snapshots++;
    if (previous && previous.snapshot.generation === snapshot.generation && previous.snapshot.requestId === snapshot.requestId && snapshot.audibleFrame >= previous.snapshot.audibleFrame) {
      values.advanced += Number(nativeFrame !== previous.nativeFrame);
      if (values.wallGaps.length < 4096) values.wallGaps.push(now - previous.time);
      if (values.audioGaps.length < 4096) values.audioGaps.push((snapshot.audibleFrame - previous.snapshot.audibleFrame) / 32);
      const old = new Uint8Array(previous.snapshot.payload);
      for (let address = 0; address < ARAM_BYTES; address++) if (bytes[address] !== old[address]) { values.ramChanged++; break; }
      if (previous.echoStart === echoStart && previous.echoLength === echoLength) {
        let changed = 0;
        const activity = snapshot.combinedActivity ?? bytes.subarray(ARAM_BYTES, ARAM_BYTES + ACTIVITY_BYTES);
        for (let offset = 0; offset < echoLength; offset++) {
          const address = (echoStart + offset) & 0xffff;
          changed += Number(bytes[address] !== old[address]);
          if (countWrites) values.writtenEchoAddresses += Number(Boolean(activity[8192 + (address >>> 3)] & (1 << (address & 7))));
          else if (changed) break;
        }
        values.echoChanged += Number(changed > 0);
        if (countWrites) values.changedEchoBytes += changed;
        if (changed) this.unchangedSince = null;
        else {
          this.unchangedSince ??= previous.time;
          values.longestUnchangedEchoMs = Math.max(values.longestUnchangedEchoMs, now - this.unchangedSince);
        }
      } else this.unchangedSince = null;
    } else this.unchangedSince = null;
    // These are owned UI buffers, never worklet recycle buffers or history-ring views.
    this.previous = { snapshot, time: now, nativeFrame, echoStart, echoLength };
  }
  sample(seconds: number): ByteRefreshRates {
    const values = this.values;
    const quantile = (list: number[], q: number) => {
      list.sort((a, b) => a - b);
      return list.length ? Math.round(list[Math.min(list.length - 1, Math.floor(list.length * q))] * 10) / 10 : 0;
    };
    const rate = (value: number) => Math.round(value / seconds);
    const result = {
      snapshots: rate(values.snapshots), advanced: rate(values.advanced), ramChanged: rate(values.ramChanged), echoChanged: rate(values.echoChanged),
      changedEchoBytes: rate(values.changedEchoBytes), writtenEchoAddresses: rate(values.writtenEchoAddresses), longestUnchangedEchoMs: Math.round(values.longestUnchangedEchoMs),
      wallGapMedian: quantile(values.wallGaps, .5), wallGap95: quantile(values.wallGaps, .95), audioGap95: quantile(values.audioGaps, .95),
    };
    this.values = counters();
    return result;
  }
}

export class ByteRefreshMonitor {
  private received = new Channel();
  private presented = new Channel();
  private readonly started: number;
  private sampledAt: number;
  readonly measurements: ByteRefreshMeasurement[] = [];
  constructor(now = performance.now()) { this.started = now; this.sampledAt = now; }
  receive(snapshot: Snapshot, now = performance.now()) { this.received.observe(snapshot, now, false); }
  present(snapshot: Snapshot, now = performance.now()) { this.presented.observe(snapshot, now, true); }
  sample(now = performance.now(), context: Pick<ByteRefreshMeasurement, 'mode' | 'geometry' | 'target'> = {}): ByteRefreshMeasurement {
    const seconds = Math.max(.001, (now - this.sampledAt) / 1000);
    const latest = this.presented.previous;
    const row: ByteRefreshMeasurement = {
      elapsedSeconds: (now - this.started) / 1000, recordedAt: new Date().toISOString(),
      received: this.received.sample(seconds), presented: this.presented.sample(seconds),
      echoStart: latest?.echoStart ?? null, echoLength: latest?.echoLength ?? 0, ...context,
    };
    this.sampledAt = now; this.measurements.push(row);
    if (this.measurements.length > 120) this.measurements.shift();
    return row;
  }
}
