// Development only: regenerate with node --experimental-transform-types.
import { writeFile } from 'node:fs/promises';
import { StreamingSincResampler } from '../../src/audio/resampler.ts';
const output = Buffer.alloc(4 * (8 + 256 * 2 * 4));
let offset = 0;
for (const rate of [32000, 44100, 48000, 96000]) {
  const input = new Int16Array(2048 * 2);
  for (let i = 0; i < input.length; ++i) input[i] = ((i * 137) % 65536) - 32768;
  const resampler = new StreamingSincResampler(32000, rate);
  resampler.push(input);
  const left = new Float32Array(256), right = new Float32Array(256);
  if (resampler.read(left, right) !== 256) throw new Error('Incomplete reference output');
  output.writeUInt32LE(rate, offset); output.writeUInt32LE(256, offset + 4); offset += 8;
  for (let i = 0; i < 256; ++i) {
    output.writeFloatLE(left[i], offset); output.writeFloatLE(right[i], offset + 4); offset += 8;
  }
}
await writeFile(new URL('../tests/fixtures/resampler.bin', import.meta.url), output);
