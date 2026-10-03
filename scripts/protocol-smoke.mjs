import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const assets = new URL('../dist/assets/', import.meta.url);
const workletName = (await readdir(assets)).find((name) => /^spc\.worklet-.*\.js$/.test(name));
if (!workletName) throw new Error('Built worklet was not found');

let Processor;
const events = [];
runInNewContext(await readFile(new URL(workletName, assets), 'utf8'), {
  AudioWorkletProcessor: class {
    port = {
      onmessage: null,
      postMessage: (event, transfer = []) => events.push(structuredClone(event, { transfer })),
    };
  },
  registerProcessor: (_name, constructor) => { Processor = constructor; },
  sampleRate: 48_000,
  WebAssembly, ArrayBuffer, Uint8Array, Int16Array, Float32Array, DataView, Math,
});
const processor = new Processor();
const wasmFile = await readFile(new URL('../public/spc_core.wasm', import.meta.url));
await processor.initializeWasm(wasmFile.buffer.slice(wasmFile.byteOffset, wasmFile.byteOffset + wasmFile.byteLength));

const makeSpc = (marker) => {
  const image = new Uint8Array(0x10180);
  image.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'));
  image.set([0x1a, 0x1a, 0x1a, 0x1e], 0x21);
  image[0x25] = 0;
  image[0x26] = 2;
  image[0x100 + 0xf1] = 0;
  image[0x100 + 0x200] = 0x2f;
  image[0x100 + 0x201] = 0xfe;
  image[0x100 + 0x1234] = marker;
  return image.buffer;
};

events.length = 0;
processor.handle({ type: 'load', loadId: 2, bytes: makeSpc(2), paused: true });
processor.handle({ type: 'load', loadId: 1, bytes: makeSpc(1), paused: true });
assert.deepEqual(events.filter((event) => event.type === 'loaded').map((event) => event.loadId), [2]);
assert.equal(events.some((event) => event.type === 'error' && event.loadId === 1), true);

events.length = 0;
processor.handle({ type: 'pause', commandId: 5, paused: false });
const output = [[new Float32Array(128), new Float32Array(128)]];
for (let index = 0; index < 12; index += 1) processor.process([], output);
processor.handle({ type: 'pause', commandId: 6, paused: true });
for (let index = 0; index < 12; index += 1) processor.process([], output);
assert.equal(events.some((event) => event.type === 'state' && event.commandId === 6 && !event.playing), true);

events.length = 0;
processor.handle({ type: 'restart', loadId: 3 });
assert.equal(events.some((event) => event.type === 'loaded' && event.loadId === 3 && event.paused), true);
assert.equal(events.some((event) => event.type === 'snapshot'), true);
assert.equal(events.some((event) => event.type === 'state' && !event.playing && event.paused), true);

events.length = 0;
processor.handle({ type: 'pause', commandId: 7, paused: false });
for (let index = 0; index < 12; index += 1) processor.process([], output);
processor.handle({ type: 'load', loadId: 4, bytes: makeSpc(4), paused: false });
assert.equal(processor.pendingLoad?.loadId, 4);
processor.handle({ type: 'load', loadId: 5, bytes: new ArrayBuffer(64), paused: false });
assert.equal(processor.pendingLoad, null);
assert.equal(processor.targetGain, processor.volume);
assert.equal(events.some((event) => event.type === 'error' && event.loadId === 5), true);

events.length = 0;
processor.handle({ type: 'load', loadId: 6, bytes: makeSpc(6), paused: false });
processor.handle({ type: 'pause', commandId: 8, paused: true });
for (let index = 0; index < 12; index += 1) processor.process([], output);
assert.equal(events.some((event) => event.type === 'loaded' && event.loadId === 6 && event.paused), true);
assert.equal(events.some((event) => event.type === 'state' && event.commandId === 8 && event.paused && !event.playing), true);

processor.wasm.web_spc_dispose();
console.log('Worklet protocol verified: stale rejection, pause acknowledgement, paused restart, and failed replacement recovery');
