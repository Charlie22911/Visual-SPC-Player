import { describe, expect, test } from 'vitest';
import { StreamingSincResampler } from '../src/audio/resampler';

const stereoRamp = (frames: number) => {
  const data = new Int16Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    data[frame * 2] = frame - 1000;
    data[frame * 2 + 1] = 1000 - frame;
  }
  return data;
};

describe('streaming sample-rate conversion', () => {
  test('passes 32 kHz stereo samples through exactly after int16 normalization', () => {
    const resampler = new StreamingSincResampler(32000, 32000);
    const input = stereoRamp(256);
    resampler.push(input);
    const left = new Float32Array(256);
    const right = new Float32Array(256);
    expect(resampler.read(left, right)).toBe(256);
    for (let i = 0; i < 256; i += 1) {
      expect(left[i]).toBe(input[i * 2] / 32768);
      expect(right[i]).toBe(input[i * 2 + 1] / 32768);
    }
  });

  test('produces the same 48 kHz stream when input arrives in irregular chunks', () => {
    const input = stereoRamp(4096);
    const continuous = new StreamingSincResampler(32000, 48000);
    continuous.push(input);
    const wantLeft = new Float32Array(8000);
    const wantRight = new Float32Array(8000);
    const wantFrames = continuous.read(wantLeft, wantRight);

    const chunked = new StreamingSincResampler(32000, 48000);
    const gotLeft: number[] = [];
    const gotRight: number[] = [];
    let inputOffset = 0;
    for (const frames of [31, 257, 19, 1024, 7, 777, 1981]) {
      chunked.push(input.subarray(inputOffset * 2, (inputOffset + frames) * 2));
      inputOffset += frames;
      const left = new Float32Array(700);
      const right = new Float32Array(700);
      let read = 0;
      do {
        read = chunked.read(left, right);
        for (let i = 0; i < read; i += 1) {
          gotLeft.push(left[i]);
          gotRight.push(right[i]);
        }
      } while (read === left.length);
    }

    expect(gotLeft.length).toBe(wantFrames);
    expect(gotRight.length).toBe(wantFrames);
    expect(Float32Array.from(gotLeft)).toEqual(wantLeft.subarray(0, wantFrames));
    expect(Float32Array.from(gotRight)).toEqual(wantRight.subarray(0, wantFrames));
  });

  test('keeps silence silent at 44.1 and 48 kHz', () => {
    for (const rate of [44100, 48000]) {
      const resampler = new StreamingSincResampler(32000, rate);
      resampler.push(new Int16Array(4096 * 2));
      const left = new Float32Array(4096);
      const right = new Float32Array(4096);
      const frames = resampler.read(left, right);
      expect(frames).toBeGreaterThan(3000);
      expect(left.subarray(0, frames).every((value) => value === 0)).toBe(true);
      expect(right.subarray(0, frames).every((value) => value === 0)).toBe(true);
    }
  });

  test('preserves a 1 kHz tone frequency when converting to 48 kHz', () => {
    const input = new Int16Array(3200 * 2);
    for (let frame = 0; frame < 3200; frame += 1) {
      const sample = Math.round(Math.sin(2 * Math.PI * 1000 * frame / 32000) * 20000);
      input[frame * 2] = sample;
      input[frame * 2 + 1] = sample;
    }
    const resampler = new StreamingSincResampler(32000, 48000);
    resampler.push(input);
    const left = new Float32Array(5000);
    const right = new Float32Array(5000);
    const frames = resampler.read(left, right);
    let positiveCrossings = 0;
    for (let index = 200; index < frames; index += 1) {
      if (left[index - 1] <= 0 && left[index] > 0) positiveCrossings += 1;
    }
    const seconds = (frames - 200) / 48000;
    expect(positiveCrossings / seconds).toBeGreaterThan(985);
    expect(positiveCrossings / seconds).toBeLessThan(1015);
  });

  test('attenuates content above the output Nyquist frequency when downsampling', () => {
    const input = new Int16Array(6400 * 2);
    for (let frame = 0; frame < 6400; frame += 1) {
      const sample = Math.round(Math.sin(2 * Math.PI * 14000 * frame / 32000) * 30000);
      input[frame * 2] = sample;
      input[frame * 2 + 1] = sample;
    }
    const resampler = new StreamingSincResampler(32000, 16000);
    resampler.push(input);
    const left = new Float32Array(4000);
    const right = new Float32Array(4000);
    const frames = resampler.read(left, right);
    const rms = Math.sqrt(left.subarray(100, frames).reduce((sum, value) => sum + value * value, 0) / (frames - 100));
    expect(rms).toBeLessThan(0.08);
  });
});
