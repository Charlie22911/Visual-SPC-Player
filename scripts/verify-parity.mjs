import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'spc-parity-'));
const input = join(temporary, 'fixture.spc');
const output = join(temporary, 'native.wav');
const image = new Uint8Array(0x10180);
image.set(new TextEncoder().encode('SNES-SPC700 Sound File Data v0.30'));
image.set([0x1a, 0x1a, 0x1a, 0x1e], 0x21);
for (let address = 0; address < 65536; address += 1) image[0x100 + address] = (address ^ (address >> 8)) & 0xff;
image[0x100 + 0xf1] = 0;
image[0x25] = 0;
image[0x26] = 2;
image[0x100 + 0x200] = 0x2f;
image[0x100 + 0x201] = 0xfe;
await writeFile(input, image);

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Native parity renderer failed');
};
if (process.platform === 'win32') {
  const wslPath = (path) => spawnSync('wsl.exe', ['-e', 'wslpath', '-a', path], { encoding: 'utf8' }).stdout.trim();
  run('wsl.exe', ['-e', wslPath(join(project, 'native', 'build-release', 'spc_web_render')), wslPath(input), wslPath(output), '1']);
} else {
  run(join(project, 'native', 'build-release', 'spc_web_render'), [input, output, '1']);
}
const nativePcm = (await readFile(output)).subarray(44);

const wasmFile = await readFile(join(project, 'public', 'spc_core.wasm'));
let memory;
const wasi = {
  proc_exit: (code) => { throw new Error('WASM exited with code ' + code); },
  fd_close: () => 0,
  fd_write: (_fd, _iov, _count, written) => { if (memory && written) new DataView(memory.buffer).setUint32(written, 0, true); return 0; },
  fd_seek: (_fd, _offset, _whence, result) => { if (memory && result) new DataView(memory.buffer).setBigUint64(result, 0n, true); return 0; },
};
const { instance } = await WebAssembly.instantiate(wasmFile, { wasi_snapshot_preview1: wasi });
const core = instance.exports;
memory = core.memory;
core._initialize();
assert.equal(core.web_spc_init(), 0);
const imagePointer = core.malloc(image.length);
new Uint8Array(memory.buffer, imagePointer, image.length).set(image);
assert.equal(core.web_spc_prepare(imagePointer, image.length, 1), 0);
assert.equal(core.web_spc_commit_prepared(), 0);
core.free(imagePointer);
const blockFrames = 512;
const renderPointer = core.malloc(blockFrames * 4);
const wasmPcm = Buffer.alloc(32000 * 4);
for (let frame = 0; frame < 32000; frame += blockFrames) {
  const frames = Math.min(blockFrames, 32000 - frame);
  assert.equal(core.web_spc_render(renderPointer, frames), 0);
  const block = new Uint8Array(memory.buffer, renderPointer, frames * 4);
  wasmPcm.set(block, frame * 4);
}
assert.deepEqual(wasmPcm, nativePcm);
core.free(renderPointer);
core.web_spc_dispose();
await rm(temporary, { recursive: true, force: true });
console.log('Native/WASM parity verified: 32,000 stereo frames are byte-identical');
