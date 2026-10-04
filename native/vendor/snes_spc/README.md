# snes_spc attribution

This directory contains **snes_spc 0.9.0 by Shay Green (blargg)**, including the SPC700 CPU, S-DSP, and `blargg_*` support headers.

- Upstream: [Blargg's Audio Libraries](https://www.slack.net/~ant/libs/audio.html#snes_spc)
- Source: [blarggs-audio-libraries/snes_spc](https://github.com/blarggs-audio-libraries/snes_spc)
- Base revision: `ec8ee2bbe30451614c1d02a83f7af1c97d497d45`
- Copyright (C) 2004-2007 Shay Green (SPC700 core)
- Copyright (C) 2007 Shay Green (S-DSP implementation)
- License: GNU Lesser General Public License, version 2.1 or later; the original license texts are retained in [license.txt](license.txt) and [LICENSE](LICENSE).

`SNES_SPC.cpp`, `SNES_SPC.h`, `SNES_SPC_misc.cpp`, `SPC_CPU.h`, `SPC_DSP.cpp`, and `SPC_DSP.h` contain modifications for the copied ARAM, DSP, and voice state and optional read/write/execute activity used by Pico-SPC-Player and Visual SPC Player. Their upstream copyright and LGPL notices are retained. The other imported code files match the base revision apart from line endings.

Earlier work and contributors are acknowledged in the [upstream documentation](https://github.com/blarggs-audio-libraries/snes_spc/blob/ec8ee2bbe30451614c1d02a83f7af1c97d497d45/snes_spc.txt#L278-L289). See the repository's [third-party notices](../../../NOTICE.md) for the other bundled components.
