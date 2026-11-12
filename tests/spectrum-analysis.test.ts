// @ts-expect-error Node builtins are used only by the test runner.
import { readFileSync } from 'node:fs';
// @ts-expect-error Node builtins are used only by the test runner.
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { SpectrumAnalysis, type SpectrumWasmExports } from '../src/spectrum/analysis.worker';
import { SPECTRUM_RESULT_CREDITS, type SpectrumPcmPacket, type SpectrumWorkerEvent } from '../src/spectrum/types';

type FrameEvent = Extract<SpectrumWorkerEvent, { type: 'frame' }>;
const setup = async (fft = 2048, hop = 256) => {
  const result = await WebAssembly.instantiate(readFileSync(resolve('public/spc_spectrum.wasm')));
  const wasm = result.instance.exports as unknown as SpectrumWasmExports;
  wasm._initialize();
  const frames: FrameEvent[] = [];
  const reports: Extract<SpectrumWorkerEvent, { type: 'stats' }>[] = [];
  const analysis = new SpectrumAnalysis(wasm, 7, fft, hop, (event, transfer) => {
    const owned = structuredClone(event, { transfer });
    if (owned.type === 'frame') frames.push(owned);
    if (owned.type === 'stats') reports.push(owned);
  });
  return { analysis, frames, reports };
};
const packet = (nativeFrame: number, generation = 2, discontinuity = 0): SpectrumPcmPacket => {
  const samples = new Int16Array(1024);
  for (let i = 0; i < 512; ++i) samples[i * 2] = samples[i * 2 + 1] = Math.round(16384 * Math.sin(2 * Math.PI * 64 * (nativeFrame + i) / 2048));
  return { type: 'pcm', epoch: 7, nativeFrame, generation, discontinuity, frames: 512, dropped: 0, buffer: samples.buffer };
};

test('real WASM produces calibrated borrowed stereo rows with exclusive native frame timestamps', async () => {
  const { analysis, frames } = await setup();
  for (let f = 0; f < 2048; f += 512) analysis.ingest(packet(f));
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ epoch: 7, generation: 2, bins: 1025, nativeFrame: 2048, sequence: 1 });
  const values = new Float32Array(frames[0].buffer);
  expect(values[128]).toBeCloseTo(0.25, 4);
  expect(values[129]).toBe(0);
});

test('missing PCM, explicit discontinuity, and new generations start complete fresh windows', async () => {
  const { analysis, frames } = await setup();
  analysis.ingest(packet(0));
  for (let f = 4096; f < 6144; f += 512) analysis.ingest(packet(f));
  expect(frames).toHaveLength(1);
  expect(frames[0].nativeFrame).toBe(6144);
  const segment = frames[0].segment;
  analysis.ingest(packet(6144, 2, 1));
  expect(frames).toHaveLength(1);
  for (let f = 0; f < 2048; f += 512) analysis.ingest(packet(f, 3));
  expect(frames).toHaveLength(2);
  expect(frames[1]).toMatchObject({ generation: 3, nativeFrame: 2048 });
  expect(frames[1].segment).toBeGreaterThan(segment);
  analysis.ingest(packet(2048, 2));
  analysis.ingest({ ...packet(2048, 3), epoch: 6 });
  expect(frames).toHaveLength(2);
});

test('result credits bound queued payloads under a stalled UI and recover by recycling', async () => {
  const { analysis, frames, reports } = await setup(2048, 64);
  for (let f = 0; f < 32768; f += 512) analysis.ingest(packet(f));
  expect(frames).toHaveLength(SPECTRUM_RESULT_CREDITS);
  expect(reports.at(-1)?.dropped).toBeGreaterThan(400);
  expect(reports.at(-1)?.analysed).toBe(481);
  const returned = frames[0].buffer;
  analysis.recycle(6, returned);
  analysis.ingest(packet(32768));
  expect(frames).toHaveLength(SPECTRUM_RESULT_CREDITS);
  analysis.recycle(7, returned);
  analysis.ingest(packet(33280));
  expect(frames).toHaveLength(SPECTRUM_RESULT_CREDITS + 1);
  expect(frames.at(-1)?.nativeFrame).toBe(33344);
});
