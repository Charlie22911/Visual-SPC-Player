import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = resolve(project, 'native');
const build = resolve(native, 'build-wasm');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: project,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

if (process.platform === 'win32') {
  const toWsl = (path) => {
    const result = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', path], {
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error('Unable to translate the project path for WSL.');
    return result.stdout.trim();
  };
  const nativeWsl = toWsl(native);
  const buildWsl = toWsl(build);
  const command = [
    'set -e',
    'emcmake cmake -S ' + shellQuote(nativeWsl) + ' -B ' + shellQuote(buildWsl) + ' -G Ninja -DCMAKE_BUILD_TYPE=Release',
    'cmake --build ' + shellQuote(buildWsl),
  ].join('; ');
  run('wsl.exe', ['-e', 'bash', '-lc', command]);
} else {
  run('emcmake', ['cmake', '-S', native, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release']);
  run('cmake', ['--build', build]);
}
