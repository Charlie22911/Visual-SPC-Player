# Building and testing

## Prerequisites

- Node.js 24 or newer
- pnpm as pinned by `packageManager` in `package.json`
- CMake 3.20 or newer, Ninja, and a C/C++ compiler
- Emscripten 3.1.6 or newer, with `emcmake` on PATH
- On Windows, WSL with the native and Emscripten toolchains

The WebAssembly build uses C11 and C++17.

## Install and build

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

The build compiles the core to `public/spc_core.wasm`, type-checks the application, and emits the static site into `dist/`. `pnpm dev` serves the source interface with the compiled WebAssembly file. Run `pnpm build:native` to rebuild only that file.

Use `pnpm preview` or the dependency-free `node scripts/serve-dist.mjs` to serve an existing production build. These generated directories and files are excluded from Git.

To compile the WebAssembly core directly on Linux or inside WSL:

```sh
emcmake cmake -S native -B native/build-wasm -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/build-wasm
```

The distribution's native source bundle contains `native/`, `scripts/build-wasm.mjs`, and these instructions. Those files are sufficient to rebuild the core without the browser application sources.

## Application and core checks

```sh
pnpm test
pnpm typecheck
pnpm test:wasm
pnpm test:protocol
```

Build native tests in both configurations on Linux or inside WSL. The harness remains active when `NDEBUG` is defined.

```sh
cmake -S native -B native/build-release -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/build-release
ctest --test-dir native/build-release --output-on-failure

cmake -S native -B native/build-debug -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build native/build-debug
ctest --test-dir native/build-debug --output-on-failure

pnpm test:parity
```

Run the final parity command from the project folder in your Node.js environment. It compares 32,000 stereo frames against `native/build-release/spc_web_render`; on Windows it runs that executable through WSL.

## Browser checks

Build the standalone file with `pnpm build:single`, install the Playwright browser, and start the production server in a separate terminal:

```sh
pnpm exec playwright install chromium
node scripts/serve-dist.mjs
```

Then run:

```sh
pnpm test:browser
pnpm test:data-views
pnpm test:underlay-layout
pnpm test:waterfall-retention
pnpm test:waterfall
```

The harness defaults to Playwright's Chromium. To test an installed browser, set `SPC_BROWSER_CHANNEL` to a supported channel such as `msedge` or `chrome`. Set `SPC_PREVIEW_URL` to use a different server; the default is `http://127.0.0.1:4173/`.

Screenshots and performance records go into ignored `artifacts/`, or into `SPC_ARTIFACT_DIR` when set. Generated SPC fixtures are created in memory or temporary directories.

| Check | Coverage |
| --- | --- |
| `test:browser` | User-gesture playback, track replacement, navigation, responsive layout, HTTP errors, and offline first playback |
| `test:data-views` | Activity/Data/Entropy controls, known byte/bit pixels, XOR, entropy values, and saved settings |
| `test:underlay-layout` | Stable plot geometry and inspection with Byte/Bit backgrounds at desktop, tablet, and phone sizes |
| `test:waterfall-retention` | Live 10-second history and synthetic 240 Hz coverage at each time window |
| `test:waterfall` | Rendering variants, zoom, selected rates, eviction, standalone playback, and touch interaction |
| `test:endurance` | Ten-minute playback; override duration with `SPC_ENDURANCE_MS` |

Phone-size browser checks emulate viewport and touch input. They do not establish compatibility with physical mobile devices or measure a physical 240 Hz display.

## Prepare a release

```sh
pnpm build:release
```

This runs the full build and places `Visual-SPC-Player.html` and `SHA256SUMS` in `release/v<package-version>/`. The HTML embeds all application assets, native build sources, and license texts. Run the relevant checks against that build before attaching the two files to a GitHub release. Source downloads come from the release's matching Git tag.

The build workflow under `.github/workflows/` runs application, native, WebAssembly, protocol, parity, and browser checks and retains the generated HTML as a workflow artifact. It does not create tags, publish a release, or deploy the site.

Before distributing `dist/` or the HTML, check that the bundle contains no `.spc`, `.wav`, or `.pcm` files.
