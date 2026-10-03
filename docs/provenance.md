# Source provenance

I built Visual SPC Player as a browser player using the audio backend from Pico-SPC-Player. The browser interface, audio worklet, memory presentations, library, and offline packaging live in this repository.

The reusable Pico backend is under `native/backend/`, and the native WAV renderer is under `native/tools/`. Both are covered by the MIT License in the repository root, which retains the Pico-SPC-Player copyright notice.

The emulator under `native/vendor/snes_spc/` is Shay Green's `snes_spc`, based on upstream commit `ec8ee2bbe30451614c1d02a83f7af1c97d497d45`. It is licensed under LGPL-2.1-or-later. Local modifications provide copied ARAM, DSP, and voice state and access activity for the visualizer. Original license and copyright notices remain beside the source.

[source-provenance.json](source-provenance.json) records native component origins, revisions, and licenses. JavaScript versions are pinned in `package.json` and `pnpm-lock.yaml`; distribution notices are in [NOTICE.md](../NOTICE.md).

The source tree builds independently of the firmware project. Both the static site and standalone HTML include the native sources and build instructions used for the WebAssembly core. See [building.md](building.md) for compilation and verification commands.
