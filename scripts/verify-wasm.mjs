import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const bytes = await readFile(new URL('../public/spc_core.wasm', import.meta.url));
let memory;
const wasi = {
  proc_exit(code) {
    throw new Error('WASM exited with code ' + code);
  },
  fd_close() {
    return 0;
  },
  fd_write(_fd, _iov, _count, written) {
    if (memory && written) new DataView(memory.buffer).setUint32(written, 0, true);
    return 0;
  },
  fd_seek(_fd, _offset, _whence, result) {
    if (memory && result) new DataView(memory.buffer).setBigUint64(result, 0n, true);
    return 0;
  },
};

const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
const core = instance.exports;
memory = core.memory;
core._initialize();
assert.equal(core.web_spc_abi_version(), 1);
assert.equal(core.web_spc_init(), 0);

const image = new Uint8Array(0x10180);
image.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'), 0);
for (let address = 0; address < 65536; address += 1) image[0x100 + address] = (address + 3) & 0xff;
image[0x100 + 0xf1] = 0;
image[0x25] = 0;
image[0x26] = 2;
image[0x100 + 0x200] = 0x2f;
image[0x100 + 0x201] = 0xfe;

const imagePointer = core.malloc(image.length);
new Uint8Array(memory.buffer, imagePointer, image.length).set(image);
assert.equal(core.web_spc_prepare(imagePointer, image.length, 0), 0);
assert.equal(core.web_spc_prepare(0, 0, 0), 1);
assert.equal(core.web_spc_commit_prepared(), 6);
assert.equal(core.web_spc_prepare(imagePointer, image.length, 0), 0);
core.free(imagePointer);
assert.equal(core.web_spc_commit_prepared(), 0);
assert.equal(core.web_spc_generation(), 1);

const pcmPointer = core.malloc(512 * 2 * Int16Array.BYTES_PER_ELEMENT);
assert.equal(core.web_spc_render(pcmPointer, 512), 0);
assert.equal(core.web_spc_generated_frames(), 512);

const aramPointer = core.malloc(65536);
assert.equal(core.web_spc_copy_aram(aramPointer, 65536), 0);
const aram = new Uint8Array(memory.buffer, aramPointer, 65536);
assert.equal(aram[0x1234], image[0x100 + 0x1234]);

const activityPointer = core.malloc(24576);
assert.equal(core.web_spc_take_activity(activityPointer, 24576), 0);
const activity = new Uint8Array(memory.buffer, activityPointer, 24576);
assert.equal(activity.some((value) => value !== 0), true);

const statePointer = core.malloc(288);
assert.equal(core.web_spc_copy_state(statePointer, 288), 0);
const state = new DataView(memory.buffer, statePointer, 288);
assert.equal(state.getUint32(0, true), 1);
assert.equal(state.getUint32(4, true), 288);
assert.equal(state.getUint32(8, true), 1);

// Execute the changing-memory fixture through the real CPU before relying on it
// for browser pixels. Sampling a fast wrapping counter need not change every time.
image[0x100 + 0x1234] = 0;
image.set([0xac, 0x34, 0x12, 0x2f, 0xfb], 0x100 + 0x200);
const changingPointer = core.malloc(image.length);
new Uint8Array(memory.buffer, changingPointer, image.length).set(image);
assert.equal(core.web_spc_prepare(changingPointer, image.length, 0), 0);
core.free(changingPointer);
assert.equal(core.web_spc_commit_prepared(), 0);
const values = new Set();
for (let i = 0; i < 24; i++) {
  assert.equal(core.web_spc_render(pcmPointer, 128), 0);
  assert.equal(core.web_spc_copy_aram(aramPointer, 65536), 0);
  values.add(aram[0x1234]);
}
assert(values.size > 1, 'INC fixture must produce distinct raw ARAM values');

core.free(pcmPointer);
core.free(aramPointer);
core.free(activityPointer);
core.free(statePointer);
core.web_spc_dispose();
console.log('WASM ABI verified: load, render, ARAM, activity, state, and changing-memory fixture');
