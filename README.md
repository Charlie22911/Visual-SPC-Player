# Visual SPC Player

I built Visual SPC Player to play Super Nintendo SPC files and explore the SPC700 / S-DSP sound system through live memory and access visualizations. The audio core runs locally in WebAssembly, with an interface designed for desktop and phone screens.

Selected music stays on your device. No music is bundled with the application.

## Try it

1. [Download Visual-SPC-Player.html](https://github.com/Charlie22911/Visual-SPC-Player/releases/latest/download/Visual-SPC-Player.html) and open it in a browser.
2. [Download SNEStronizer.spc](https://raw.githubusercontent.com/ResistanceVault/demo-twistit/master/data/SNEStronizer.spc).
3. In the player, choose **Open SPC files** and select the downloaded SPC.

**SNEStronizer** is music by **AceMan** from **Resistance's TwistIT** SNES / Super Famicom demo. Visit the [TwistIT repository](https://github.com/ResistanceVault/demo-twistit) or [view the SPC on GitHub](https://github.com/ResistanceVault/demo-twistit/blob/master/data/SNEStronizer.spc). The source repository publishes an [MIT license](https://github.com/ResistanceVault/demo-twistit/blob/master/LICENSE.txt).

## Features

- Open individual `.spc` files or browse a searchable folder library.
- Play through an AudioWorklet with sample-rate conversion.
- Inspect all 64 KiB of ARAM as Activity, Data, or Entropy.
- Switch between a 2D Map and a scrolling Waterfall, with zoom down to individual bytes or bits.
- Choose Byte or Bit representations, show matching data beneath Activity, and use XOR to highlight captured changes.
- Inspect all eight DSP voices, 128 DSP registers, and ID666 track metadata.
- Save and export settings, measure snapshot cadence, and cache the hosted app for offline use.

## Portable release

Download `Visual-SPC-Player.html` from the [latest release](https://github.com/Charlie22911/Visual-SPC-Player/releases/latest) and open it in a browser. The single file embeds the interface, audio processor, WebAssembly core, notices, and native build sources. It does not need an application server or fetch application assets.

Browser restrictions on local-file audio vary. If the file cannot initialize audio, run a source build through a local server instead. See [standalone instructions](docs/standalone.md).

## Build from source

Install Node.js 24+, the pnpm version specified in `package.json`, CMake, Ninja, and Emscripten. On Windows, the native build script uses those tools inside WSL.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

For the production build, run `node scripts/serve-dist.mjs` and open `http://127.0.0.1:4173`. The source entry `index.html` requires a server; it is not the portable release.

Generate the standalone file and release checksum with:

```sh
pnpm build:release
```

The outputs are `release/v<version>/Visual-SPC-Player.html` and `SHA256SUMS`. Generated releases and `dist/` stay outside Git. See [building and testing](docs/building.md) for the complete toolchain and verification commands.

## Source layout

| Path | Contents |
| --- | --- |
| `src/aram/` | Memory metrics, Map and Waterfall renderers, history, and inspection |
| `src/audio/` | AudioWorklet, engine, resampling, snapshot protocol, and diagnostics |
| `src/player/` | Voice and DSP panels |
| `src/library/` | Local file and folder library |
| `src/` | Application interface, settings, and offline support |
| `native/backend/` | Reusable SPC backend and copied state |
| `native/vendor/snes_spc/` | Emulator source and its original notices |
| `native/tools/`, `native/tests/` | Native WAV renderer and test harnesses |
| `public/` | Icons and install metadata |
| `scripts/` | Build, release packaging, local server, and browser checks |
| `tests/` | Application and renderer tests with generated fixtures |
| `docs/`, `LICENSES/` | Public documentation, provenance, and licenses |

## Hosted and offline use

Serve `dist/` over HTTPS to use audio and installation on another device. Localhost HTTP works on the same computer; a phone visiting a PC's plain HTTP LAN address does not have the secure context required for AudioWorklet playback.

Use the browser's **Install app** or **Add to Home Screen** action, then keep the app open until Settings reports **Available offline**. Cached application assets are versioned together. Selected music is not added to that cache, so keep your SPC files in local storage. Browser or operating-system cleanup can evict cached files. Settings offers **Update and reload** when a hosted update is ready.

## Use the player

1. Choose **Open folder** to build a library recursively, or **Open SPC files** to select individual tracks.
2. Select a track. Playback begins after the browser authorizes audio.
3. Open **ARAM**, choose **Map** or **Waterfall**, and select a measurement from the dropdown.
4. Use the mouse wheel or pinch gesture to zoom, and drag to pan.
5. Open Voices, DSP, Track, and Settings for the copied emulator state and playback details.

In **Data**, choose **Byte** or **Bit**. Enable **XOR** to show only the bits that changed between consecutive continuous captures, using the same byte colors or bit layout. The 1,024 × 512 bit map gives every byte a 4 × 2 tile. Bits 7 through 4 occupy the upper row and bits 3 through 0 the lower row, from left to right.

Waterfall places recent samples at the top and older samples below. **Fit** covers the full address space; **1:1** shows one byte per column, or one pixel per bit in Bit representations. Bits 7 through 0 appear left to right in each address bucket, with every row representing one time band. At wider address ranges, bit brightness shows the fraction of bytes in the bucket with that bit set. Its 2, 5, and 10 second windows use playback time, so changing the visualizer rate does not change the scrolling speed. Hover or tap to inspect an address bucket, bit, and time interval. Each geometry keeps its own zoom while you switch between them.

**Entropy → Byte** measures byte diversity in aligned 256-byte blocks: 0 means one repeated value; 8 bits per byte means all 256 values occur equally often. **Entropy → Bit** measures each bit position separately in those blocks: 0 means that position is fixed; 1 means equal numbers of zeros and ones. The numeric scale explains the colors, and hovering or tapping shows the value and contributing block. Entropy measures value frequencies, so a repeating pattern can also have high entropy.

Waterfall combines activity by access kind and shows the latest byte, bit, or entropy values in each time band. With XOR enabled, it combines changed-bit masks at each address across the band before reducing address buckets, preserving captured changes that return to their original value. Dark gaps indicate missing retained data or an unavailable XOR baseline.

In **Activity**, choose **Byte** or **Bit**, then enable **Show bytes underneath** or **Show bits underneath** for the corresponding darkened background beneath read, write, and execute indicators. Each displayed interval retains all accesses during that interval and shows the data captured at its end. Accesses apply to the whole byte, so the Bit view repeats an address's activity across all eight bit positions. Activity coverage is the same with or without the background, including when several audio callbacks arrive between display frames. A background bypasses activity persistence, so access trails do not carry into later intervals. At wider zoom levels, backgrounds show mean byte values or the fraction set at each bit position within the address bucket. Use **1:1** for individual bytes or bits. The representation and background toggle are included in saved and exported settings.

In **Settings**, enable **Byte refresh diagnostic** to show a collapsible measurement panel in **ARAM**. It compares received and presented snapshots, counts changed RAM and echo states, and reports snapshot spacing and audio-time advancement. A changed state means at least one byte changed; these counters do not measure physical screen refreshes. Use **Save measurements** to download up to 120 recent measurement windows as JSON. Diagnostic processing runs only while the toggle is on, and the toggle is included in saved and exported settings.

History retains the latest 10 seconds at the selected capture rate, plus a predecessor sample for XOR. Storage is allocated as needed and expired buffers are recycled; at 240 captures per second, the payloads use approximately 275 MB. The status line reports the retained duration. All three time windows fill the same plot height once enough playback history is available. Successful track loads and restarts clear history and release its storage. Settings can save the geometry, measurement, byte/bit choices, XOR toggle, and time window; history itself is not saved.

## Design and provenance

- [Architecture and memory semantics](docs/architecture.md)
- [Build and test instructions](docs/building.md)
- [Source provenance](docs/provenance.md)
- [Contributing](CONTRIBUTING.md)

## Credits and licenses

Audio emulation is provided by **Shay Green (blargg)** through [snes_spc](https://github.com/blarggs-audio-libraries/snes_spc), including its SPC700 CPU, S-DSP, and `blargg_*` support code. The emulator is **LGPL-2.1-or-later**; its original copyright and license notices remain in `native/vendor/snes_spc/`.

Project-owned code and the backend derived from [Pico-SPC-Player](https://github.com/Charlie22911/Pico-SPC-Player) are under the MIT license in [LICENSE](LICENSE). See [NOTICE.md](NOTICE.md) for the other bundled components and their credits, and [LICENSES](LICENSES) for retained terms. Both distribution formats include notices and native build sources.
