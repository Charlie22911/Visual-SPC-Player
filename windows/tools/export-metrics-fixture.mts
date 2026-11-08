import { registerHooks } from 'node:module';
import { writeFile } from 'node:fs/promises';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier))
        return nextResolve(specifier + '.ts', context);
      throw error;
    }
  },
});
const { createReducedRow, reduceRow } = await import('../../src/aram/metrics.ts');
const modes = ['activity', 'activity-bits', 'bytes', 'bits', 'xor', 'xor-bits', 'entropy', 'entropy-bits'] as const;
const payload = new Uint8Array(90400), previous = new Uint8Array(90400);
for (let a = 0; a < 65536; ++a) {
  payload[a] = (a * 37 + (a >>> 8)) & 255; previous[a] = (a * 19 + 7) & 255;
}
for (let i = 0; i < 24576; ++i) payload[65536 + i] = (i * 29 + (i >>> 8)) & 255;
const record = { payload, combinedActivity: payload.subarray(65536, 90112) };
const parts: Buffer[] = [];
for (let index = 0; index < modes.length; ++index) {
  const mode = modes[index], row = createReducedRow(mode, 7, true);
  reduceRow(record as never, { payload: previous } as never, mode, { start: 13, span: 65501 }, 7, row);
  const background = row.byteValues ?? row.bitValues;
  const header = Buffer.alloc(16);
  header.writeUInt32LE(index, 0); header.writeUInt32LE(row.values.length, 4);
  header.writeUInt32LE(background?.length ?? 0, 8); header.writeUInt32LE(row.anyChange?.length ?? 0, 12);
  parts.push(header);
  for (const array of [row.values, background]) if (array) {
    const bytes = Buffer.alloc(array.length * 4);
    array.forEach((value, i) => bytes.writeFloatLE(value, i * 4)); parts.push(bytes);
  }
  if (row.anyChange) parts.push(Buffer.from(row.anyChange));
}
await writeFile(new URL('../tests/fixtures/metrics.bin', import.meta.url), Buffer.concat(parts));
