// @ts-expect-error Node builtins are used only by the test runner.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { WorkletCommand, WorkletEvent } from '../src/audio/protocol';
import type { SpectrumPcmCredit, SpectrumPcmPacket } from '../src/spectrum/types';

interface Processor {
  initializeWasm(bytes: ArrayBuffer): Promise<void>;
  handle(command: WorkletCommand): void;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
const { createProcessor, events } = vi.hoisted(() => {
  let ProcessorClass: new () => Processor;
  const events: WorkletEvent[] = [];
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('currentTime', 0);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage(event: WorkletEvent) { events.push(event); } }; });
  vi.stubGlobal('registerProcessor', (_name: string, ctor: new () => Processor) => { ProcessorClass = ctor; });
  return { createProcessor: () => { events.length = 0; return new ProcessorClass(); }, events };
});

test('resuming after a long pause anchors media time at the current audio context time', async () => {
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('currentTime', 0);
  const processor = createProcessor();
  const file = readFileSync('public/spc_core.wasm');
  await processor.initializeWasm(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const bytes = new Uint8Array(0x10180);
  bytes.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'));
  bytes[0x26] = 2;
  bytes.set([0x2f, 0xfe], 0x300);
  processor.handle({ type: 'load', loadId: 1, bytes: bytes.buffer, paused: true });
  const lastState = () => events.filter((event): event is Extract<WorkletEvent, { type: 'state' }> => event.type === 'state').at(-1)!;
  vi.stubGlobal('currentTime', 10);
  processor.handle({ type: 'pause', commandId: 1, paused: false });
  expect(lastState()).toMatchObject({ playing: true, audibleFrame: 0, contextTime: 10 });
  const output = [[new Float32Array(128), new Float32Array(128)]];
  for (let i = 0; i < 4; ++i) {
    vi.stubGlobal('currentTime', 10 + i * 128 / 48000);
    processor.process([], output);
  }
  processor.handle({ type: 'pause', commandId: 2, paused: true });
  for (let i = 4; i < 8; ++i) {
    vi.stubGlobal('currentTime', 10 + i * 128 / 48000);
    processor.process([], output);
  }
  expect(lastState().playing).toBe(false);
  const stoppedFrame = lastState().audibleFrame;
  expect(stoppedFrame).toBeGreaterThan(0);
  vi.stubGlobal('currentTime', 100);
  processor.handle({ type: 'pause', commandId: 3, paused: false });
  expect(lastState()).toMatchObject({ playing: true, audibleFrame: stoppedFrame, contextTime: 100 });
  // A repeated acknowledgement cannot move the anchor without rendering PCM.
  vi.stubGlobal('currentTime', 100.001);
  processor.handle({ type: 'pause', commandId: 4, paused: false });
  expect(lastState()).toMatchObject({ audibleFrame: stoppedFrame, contextTime: 100 });
  vi.unstubAllGlobals();
});
import '../src/audio/spc.worklet';

beforeEach(() => {
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('currentTime', 0);
});
afterEach(() => vi.unstubAllGlobals());

test('worklet credits bound native pre-volume PCM and stale ports cannot restart disabled capture', async () => {
  const processor = createProcessor();
  const file = readFileSync('public/spc_core.wasm');
  await processor.initializeWasm(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const bytes = new Uint8Array(0x10180);
  bytes.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'));
  bytes[0x26] = 2;
  bytes.set([0x8f, 0x4c, 0xf2, 0x8f, 0x01, 0xf3, 0x2f, 0xfe], 0x300);
  bytes[0x10100] = bytes[0x10101] = bytes[0x1010c] = bytes[0x1011c] = 127;
  bytes[0x10103] = 0x10; bytes[0x10107] = 0x7f;
  bytes[0x1015d] = 0x10; bytes[0x1016c] = 0x20;
  bytes[0x1101] = bytes[0x1103] = 0x20; bytes[0x2100] = 0xc3;
  for (let i = 1; i < 9; ++i) bytes[0x2100 + i] = 0x17;
  processor.handle({ type: 'volume', gain: 0 });
  processor.handle({ type: 'load', loadId: 1, bytes: bytes.buffer, paused: false });
  const packets: SpectrumPcmPacket[] = [];
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    close: vi.fn(),
    postMessage: (packet: SpectrumPcmPacket, transfer: Transferable[]) => packets.push(structuredClone(packet, { transfer })),
  };
  processor.handle({ type: 'spectrum', epoch: 3, port: port as unknown as MessagePort });
  const credit = (buffer: ArrayBuffer): SpectrumPcmCredit => ({ type: 'credit', epoch: 3, buffer, samples: new Int16Array(buffer),
    packet: { type: 'pcm', epoch: 3, generation: 0, nativeFrame: 0, frames: 0, discontinuity: 0, dropped: 0, buffer }, transfer: [buffer] });
  for (let i = 0; i < 32; ++i) port.onmessage?.({ data: credit(new ArrayBuffer(2048)) } as MessageEvent);
  const output = [[new Float32Array(128), new Float32Array(128)]];
  for (let i = 0; i < 100; ++i) processor.process([], output);
  expect(packets).toHaveLength(32);
  expect(packets.every(p => p.epoch === 3 && p.generation > 0 && p.frames <= 512)).toBe(true);
  expect(packets.slice(1).every((p, i) => p.nativeFrame === packets[i].nativeFrame + packets[i].frames)).toBe(true);
  expect(packets.some(p => new Int16Array(p.buffer).some(value => value !== 0))).toBe(true);
  expect(output[0].every(channel => channel.every(value => value === 0))).toBe(true);
  // One returned credit resumes at actual media time; the missing interval is detectable.
  port.onmessage?.({ data: credit(packets[0].buffer) } as MessageEvent);
  processor.process([], output);
  expect(packets).toHaveLength(33);
  expect(packets[32].nativeFrame).toBeGreaterThan(packets[31].nativeFrame + packets[31].frames);
  expect(packets[32].dropped).toBeGreaterThan(0);
  processor.handle({ type: 'spectrum', epoch: 4, port: null });
  const obsoletePort = { close: vi.fn() };
  processor.handle({ type: 'spectrum', epoch: 3, port: obsoletePort as unknown as MessagePort });
  for (let i = 0; i < 10; ++i) processor.process([], output);
  expect(packets).toHaveLength(33);
  expect(port.close).toHaveBeenCalledOnce();
  expect(obsoletePort.close).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
