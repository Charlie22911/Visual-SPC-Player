# Third-party notices

Visual SPC Player application code is available under the MIT License in [LICENSE](LICENSE). The native backend and renderer include code derived from Pico-SPC-Player, whose copyright notice is retained in that license.

## snes_spc

The WebAssembly audio core includes Shay Green's `snes_spc` emulator from upstream commit `ec8ee2bbe30451614c1d02a83f7af1c97d497d45`, licensed under LGPL-2.1-or-later. Original notices are retained in `native/vendor/snes_spc/`. A copy of the license is in [LICENSES/LGPL-2.1.txt](LICENSES/LGPL-2.1.txt).

Local modifications add copied DSP and voice snapshots, ARAM access activity, byte heatmap hooks, and a copy-only ARAM accessor. Mutable emulator storage remains owned by the audio core.

The site build includes the native core, backend, CMake configuration, build script, and build instructions under `dist/source/`. The standalone HTML embeds these sources and license texts; download them from Settings. Retain the applicable notices and corresponding source when redistributing the WebAssembly binary, and follow the LGPL source and relinking requirements.

## React, React DOM, and Scheduler

The browser interface includes React, React DOM, and Scheduler, copyright Meta Platforms, Inc. and affiliates, under the MIT License. The license is retained in [LICENSES/React-MIT.txt](LICENSES/React-MIT.txt) and included in both distribution formats.

## Dependency versions

JavaScript dependency versions are recorded in `package.json` and `pnpm-lock.yaml`. Native origins and revisions are recorded in [docs/source-provenance.json](docs/source-provenance.json).
