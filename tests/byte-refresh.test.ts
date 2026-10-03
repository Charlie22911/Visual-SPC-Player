import { expect, test } from 'vitest';
import { ByteRefreshMonitor } from '../src/audio/byteRefresh';
import { VisualStream } from '../src/audio/visualStream';
import { ARAM_BYTES, ACTIVITY_BYTES } from '../src/audio/protocol';
import { makeSnapshot } from './helpers/snapshots';

const echoSnapshot = (sequence: number, byte: number, generation = 1) => {
  const snapshot = makeSnapshot(sequence, { generation, frame: sequence * 160, ram: ram => { ram[0x8000] = byte; }, activity: (_, writes) => { writes[0x8000 >>> 3] = 1; } });
  const dsp = new Uint8Array(snapshot.payload, ARAM_BYTES + ACTIVITY_BYTES + 32, 128);
  dsp[0x6d] = 0x80; dsp[0x7d] = 15;
  return snapshot;
};

test('diagnostics default off and stop observing snapshots when disabled', () => {
  const stream = new VisualStream();
  expect(stream.byteRefresh).toBeNull();
  stream.setByteRefreshEnabled(true, 0);
  const monitor = stream.byteRefresh!;
  stream.receivedSnapshot(echoSnapshot(1, 1)); stream.publish(echoSnapshot(1, 1));
  expect(monitor.sample(1000).presented.snapshots).toBe(1);
  stream.setByteRefreshEnabled(false);
  stream.receivedSnapshot(echoSnapshot(2, 2)); stream.publish(echoSnapshot(2, 2));
  expect(stream.byteRefresh).toBeNull();
  expect(monitor.sample(2000).presented.snapshots).toBe(0);
});

test('tracks unchanged contents separately from native advancement and keeps audio steps finite', () => {
  const monitor = new ByteRefreshMonitor(0);
  for (const [sequence, byte] of [[1, 10], [2, 10], [3, 20]]) {
    const snapshot = echoSnapshot(sequence, byte);
    monitor.receive(snapshot, sequence * 5); monitor.present(snapshot, sequence * 5);
  }
  const row = monitor.sample(1000);
  expect(row.presented).toMatchObject({ snapshots: 3, advanced: 2, ramChanged: 1, echoChanged: 1, changedEchoBytes: 1, writtenEchoAddresses: 2, audioGap95: 5, wallGap95: 5 });
  expect(row.received.echoChanged).toBe(1);
  expect(row.echoStart).toBe(0x8000); expect(row.echoLength).toBe(30720);
  expect(Number.isFinite(row.presented.audioGap95)).toBe(true);
  expect(monitor.sample(2000).presented).toMatchObject({ snapshots: 0, echoChanged: 0, audioGap95: 0 });
});

test('track changes establish a new baseline and echo wrapping stays in the address space', () => {
  const monitor = new ByteRefreshMonitor(0);
  monitor.present(echoSnapshot(1, 0), 1);
  const first = echoSnapshot(1, 200, 2);
  new Uint8Array(first.payload)[ARAM_BYTES + ACTIVITY_BYTES + 32 + 0x6d] = 0xff;
  monitor.present(first, 2);
  const next = echoSnapshot(2, 200, 2);
  const bytes = new Uint8Array(next.payload); bytes[0] = 1;
  bytes[ARAM_BYTES + ACTIVITY_BYTES + 32 + 0x6d] = 0xff;
  monitor.present(next, 7);
  expect(monitor.sample(1000).presented).toMatchObject({ advanced: 1, echoChanged: 1, changedEchoBytes: 1 });
});

test('counts paired interval write flags and bounds downloaded history', () => {
  const monitor = new ByteRefreshMonitor(0);
  const first = echoSnapshot(1, 1), next = echoSnapshot(2, 2);
  next.combinedActivity = new Uint8Array(ACTIVITY_BYTES);
  next.combinedActivity[8192 + (0x8000 >>> 3)] = 3;
  monitor.present(first, 1); monitor.present(next, 6);
  expect(monitor.sample(1000).presented.writtenEchoAddresses).toBe(2);
  for (let n = 2; n <= 125; n++) monitor.sample(n * 1000);
  expect(monitor.measurements).toHaveLength(120);
  expect(monitor.measurements[0].elapsedSeconds).toBe(6);
});
