# Third-party notices

Visual SPC Player application code is available under the MIT License in [LICENSE](LICENSE). The native backend and renderer include code derived from Pico-SPC-Player, whose copyright notice is retained in that license.

## snes_spc — Shay Green (blargg)

The WebAssembly audio core uses **Shay Green's (blargg) snes_spc 0.9.0**, which provides the SPC700 CPU and S-DSP emulation. It includes the library's `blargg_common.h`, `blargg_config.h`, `blargg_endian.h`, and `blargg_source.h` support code.

The imported source is based on [upstream commit ec8ee2bbe30451614c1d02a83f7af1c97d497d45](https://github.com/blarggs-audio-libraries/snes_spc/tree/ec8ee2bbe30451614c1d02a83f7af1c97d497d45). Copyright (C) 2004-2007 Shay Green applies to the SPC700 core; Copyright (C) 2007 Shay Green applies to the DSP implementation. The library is licensed under **LGPL-2.1-or-later**, separately from the application's MIT license. Original notices are retained in `native/vendor/snes_spc/`, and the full license is in [LICENSES/LGPL-2.1.txt](LICENSES/LGPL-2.1.txt). See [Blargg's Audio Libraries](https://www.slack.net/~ant/libs/audio.html#snes_spc) and the [vendor attribution](native/vendor/snes_spc/README.md).

The [upstream acknowledgements](https://github.com/blarggs-audio-libraries/snes_spc/blob/ec8ee2bbe30451614c1d02a83f7af1c97d497d45/snes_spc.txt#L278-L289) credit Anti-Resonance's SPC2ROM, Brad Martin's openspc, and Chris Moeller's openspc++ as earlier work; anomie for SNES documentation and discussions; hcs for the Rockbox C port; and Richard Bannister, Mahendra Tallur, Shazz, nenolod, theHobbit, Johan Samuelsson, nes6502, Micket, byuu, pagefault, and Nach for testing, integration, and support. These are the emulator author's acknowledgements of the work on which his libraries were built.

Local modifications add copied DSP and voice snapshots, ARAM access activity, byte heatmap hooks, and a copy-only ARAM accessor. Mutable emulator storage remains owned by the audio core.

The site build includes the native core, backend, CMake configuration, build script, build instructions, and notices under `dist/source/`. The standalone HTML embeds these sources and license texts; download them from Settings. Retain the applicable notices and corresponding source when redistributing the WebAssembly binary, and follow the LGPL source and relinking requirements.

## Pico-SPC-Player

The reusable backend in `native/backend/` and WAV renderer in `native/tools/` are derived from [Pico-SPC-Player](https://github.com/Charlie22911/Pico-SPC-Player), based on revision `51824a68120d5c49fbc9d6df04568ced7e9a8ec8`. Copyright (c) 2026 Pico-SPC-Player contributors is retained in [LICENSE](LICENSE), under the MIT License. Browser integration uses the WebAssembly C ABI and copied visual snapshots.

## React, React DOM, and Scheduler

The browser interface includes [React, React DOM, and Scheduler](https://github.com/react/react), copyright Meta Platforms, Inc. and affiliates, under the MIT License. The license is retained in [LICENSES/React-MIT.txt](LICENSES/React-MIT.txt) and included in both distribution formats.

## Vite browser helper

The compiled interface includes Vite's module-preload helper. [Vite](https://github.com/vitejs/vite) is copyright (c) 2019-present, VoidZero Inc. and Vite contributors, under the MIT License. The applicable core notice is retained in [LICENSES/Vite-MIT.txt](LICENSES/Vite-MIT.txt).

## WebAssembly runtime

The WebAssembly binary is built with [Emscripten](https://github.com/emscripten-core/emscripten). Its linked runtime support uses Emscripten code, musl C library code, LLVM C++ and compiler support, and Doug Lea's dlmalloc allocator.

- **Emscripten authors:** MIT or University of Illinois/NCSA Open Source License; retained in [LICENSES/Emscripten.txt](LICENSES/Emscripten.txt), with the original [author list](LICENSES/Emscripten-AUTHORS.txt). The standalone runtime support also retains Copyright 2019 The Emscripten Authors.
- **musl:** copyright 2005-2020 Rich Felker and contributors, under the MIT License. Its full copyright file, including contributor and component notices, is retained in [LICENSES/musl-COPYRIGHT.txt](LICENSES/musl-COPYRIGHT.txt).
- **LLVM Project contributors:** Apache-2.0 WITH LLVM-exception, with the original component notices retained in [LICENSES/LLVM-libcxx.txt](LICENSES/LLVM-libcxx.txt), [LICENSES/LLVM-libcxxabi.txt](LICENSES/LLVM-libcxxabi.txt), and [LICENSES/LLVM-compiler-rt.txt](LICENSES/LLVM-compiler-rt.txt). Their original contributor lists are retained in [libc++ credits](LICENSES/LLVM-libcxx-CREDITS.txt), [libc++abi credits](LICENSES/LLVM-libcxxabi-CREDITS.txt), and [compiler-rt credits](LICENSES/LLVM-compiler-rt-CREDITS.txt).
- **Doug Lea:** dlmalloc 2.8.6, released to the public domain under the [CC0 dedication](https://creativecommons.org/publicdomain/zero/1.0/). Its original notice is retained in [LICENSES/dlmalloc-NOTICE.txt](LICENSES/dlmalloc-NOTICE.txt); Emscripten-specific allocator changes are covered by Emscripten's license.

The retained runtime notices come from Emscripten 3.1.6, the release toolchain, whose LLVM library fork is based on LLVM 13.0.0 and whose musl sources are version 1.2.2. When distributing a build made with a different toolchain, retain the notices applicable to that toolchain's runtime.

## Dependency versions

JavaScript dependency versions are recorded in `package.json` and `pnpm-lock.yaml`. Native and bundled runtime origins are recorded in [docs/source-provenance.json](docs/source-provenance.json). Development tools and their installed dependencies retain their own notices in their packages.

The static build's `NOTICE.txt` and the standalone Settings → Licenses and notices download combine this document with the project license and every retained license in `LICENSES/`.
