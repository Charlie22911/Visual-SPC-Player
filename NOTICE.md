# Third-party notices

Project-owned application code is under the MIT License in [LICENSE](LICENSE). The backend and native renderer derive from [Pico-SPC-Player](https://github.com/Charlie22911/Pico-SPC-Player), whose MIT copyright notice is retained in that file.

## snes_spc — Shay Green (blargg)

The audio core uses **snes_spc 0.9.0 by Shay Green (blargg)** for SPC700 CPU and S-DSP emulation, including the `blargg_*` support headers. Copyright (C) 2004-2007 Shay Green applies to the SPC700 core; Copyright (C) 2007 Shay Green applies to the DSP implementation.

The emulator is **LGPL-2.1-or-later**, separately from the application's MIT license. Original notices remain in `native/vendor/snes_spc/`, and the license is retained in [LICENSES/LGPL-2.1.txt](LICENSES/LGPL-2.1.txt). The [vendor attribution](native/vendor/snes_spc/README.md) records the upstream revision and local visualization modifications. Earlier work and contributors are acknowledged in the [upstream documentation](https://github.com/blarggs-audio-libraries/snes_spc/blob/ec8ee2bbe30451614c1d02a83f7af1c97d497d45/snes_spc.txt#L278-L289).

## Other bundled components

| Component | Credit | Retained terms |
| --- | --- | --- |
| React, React DOM, Scheduler | Meta Platforms, Inc. and affiliates | [MIT](LICENSES/React-MIT.txt) |
| Vite module-preload helper | VoidZero Inc. and Vite contributors | [MIT](LICENSES/Vite-MIT.txt) |
| Emscripten runtime support | Emscripten authors, including Copyright 2019 The Emscripten Authors | [MIT or NCSA](LICENSES/Emscripten.txt) |
| musl C runtime | Rich Felker and contributors | [Copyright and component notices](LICENSES/musl-COPYRIGHT.txt) |
| LLVM runtime support | LLVM Project contributors | [Apache-2.0 with LLVM exception and retained legacy terms](LICENSES/LLVM.txt) |
| dlmalloc allocator | Doug Lea; Emscripten authors for integration | [Public-domain notice](LICENSES/dlmalloc-NOTICE.txt) and Emscripten terms |

Versions and source origins are recorded in [docs/source-provenance.json](docs/source-provenance.json) and `pnpm-lock.yaml`. The runtime notices correspond to Emscripten 3.1.6; builds using another toolchain should retain its applicable notices.

## Distribution

The static site and standalone HTML include these notices, retained license texts, and native sources with build instructions. Settings provides links to the notices and source bundle. Retain the applicable notices and corresponding source when redistributing, including the LGPL source and relinking requirements for snes_spc.
