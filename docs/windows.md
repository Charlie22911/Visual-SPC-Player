# Windows native player

The Windows application uses C++20, Win32, WASAPI shared-mode audio, and Direct3D 11. Release builds use MSVC optimization and interprocedural optimization. The emulator, interface, shaders, notices, and complete matching source are included in one executable.

## Run

Run `Visual-SPC-Player.exe` directly, or extract it from the Windows ZIP. No companion application files are required.

The build targets x64 Windows 10 22H2 and Windows 11 APIs. Windows 11 is the verified runtime platform. A Direct3D 11 feature-level 11_0 adapter provides hardware rendering; WARP provides a software fallback. The application uses the default Windows audio output device. A browser or separately installed application runtime is not required.

**Photosensitivity warning:** The visualizations can produce flashing lights and rapidly changing, high-contrast patterns. If you are sensitive to these effects, please avoid using the visualizer.

Choose **Open folder** to scan a library or **Open files** to select individual SPC files. You can also drop files onto the window. Music stays on your computer; no music is included in the package.

The library floats over the player by default. Use the arrow tab on its border to collapse or expand it. The pin button reserves space beside the player; unpinning lets it float again. The library's open and pinned states are remembered between runs. Its controls stay visible while you scroll the track list.

- **ARAM:** Activity, Data, and Entropy in Map or Waterfall, with Byte/Bit representations, XOR changes, and matching data underlays.
- **Navigation:** mouse wheel to zoom, drag to pan, **Fit** for the full address range, and **1:1** for individual logical pixels. Hover to inspect addresses, values, and time intervals.
- **Layout:** ARAM controls share one row when space permits and wrap in narrower windows. The fixed bottom bar shows inspection and legend information on the left, with playback and rendering information aligned to the right. Hover over shortened footer text to read it in full.
- **Waterfall:** 2-, 5-, and 10-second windows, with up to ten seconds of retained captures. Time span and data underlays keep the plot height fixed. Unavailable history appears separately from zero-valued data.
- **Voices / DSP / Track:** copied voice state, DSP registers, and ID666 metadata. Track durations are informational; playback continues until you pause or select another track.
- **Settings:** palettes, 30 Hz / 60 Hz / Display cadence, activity persistence, compatible settings import/export, and byte-refresh diagnostics.
- **About:** collapsible usage, credits, license, and source/build sections. Open **Source and rebuilding → Export source ZIP** to save the complete source included in this executable; no network connection is needed.

**Space** toggles playback when a text field is not active. The interface supports keyboard navigation and Windows DPI scaling. Its controls are custom rendered and do not provide full Windows UI Automation or screen-reader support.

The playback buttons use Play/Pause and Restart symbols with hover labels. Control symbols scale with the current font size. Voice table columns have fixed widths based on their value ranges and the active font, with extra room around the text. Narrow windows scroll the table horizontally instead of squeezing the cells.

Paused drawing slows when idle and responds to input immediately. Minimizing the window stops rendering while playback continues.

Settings are stored in `%LOCALAPPDATA%\VisualSPCPlayer\settings.json`. **Save library** stores folder or file locations in `library.json` in the same directory. Settings exports use the same version 3 format as the browser application and accept earlier version 1 and 2 exports.

Native library layout preferences are stored separately in `layout.json` in that directory.

## Build

Install Microsoft's **Desktop development with C++** Build Tools workload, a Windows SDK, and **C++ CMake tools for Windows**. Use CMake 3.25 or newer, Ninja, and Python 3.10 or newer.

Open an x64 Visual Studio developer command prompt in the project directory:

```text
cd windows
cmake --preset windows-x64-release
cmake --build --preset windows-x64-release
ctest --preset windows-x64-release --output-on-failure
cmake --install out/x64-release --prefix ../release/windows-x64
```

The executable is built under `windows/out/x64-release/`. The `windows-x64-debug` and `windows-x64-release-no-ipo` presets provide development configurations.

ImGui and nlohmann/json sources are vendored at the revisions recorded in their `REVISION.txt` files. The Windows SDK's FXC compiles the shaders during the build. Node.js is needed only to regenerate reference fixtures or work on the browser application.

To create the portable and matching source archives, run this from the project directory in the developer prompt with Python 3.10 or newer:

```text
python windows/tools/package.py --build-dir windows/out/x64-release
```

The executable, archives, and `SHA256SUMS` are written to `release/`. The Windows ZIP contains only the executable; the external source ZIP is identical to the archive embedded in it. CPack can also package the installed Windows files:

```text
cpack --config windows/out/x64-release/CPackConfig.cmake -G ZIP
```

## Source organization

| Location | Purpose |
| --- | --- |
| `native/desktop_api.*` | Per-instance emulator interface |
| `native/state_packet.*` | Shared, explicitly encoded snapshot packet |
| `windows/src/audio/` | WASAPI, resampling, capture scheduling, playback clock |
| `windows/src/model/` | History, reductions, settings, background file work |
| `windows/src/render/` | D3D11 device, memory shaders, numeric waterfall ring |
| `windows/src/ui/`, `windows/src/platform/` | Interface, file dialogs, Unicode paths, persistence |
| `windows/tests/`, `windows/tools/` | Native fixtures, reference exporters, packaging, benchmarks |

## Redistribution

The application code is MIT licensed. The modified snes_spc emulator by Shay Green (blargg) is LGPL-2.1-or-later. The complete source for the application, modified emulator, dependencies, and build files is embedded in the executable. You can export it, modify the emulator or application, and rebuild/relink the program. Modification and reverse engineering for debugging modifications are permitted. Retain the applicable notices, license texts, and complete corresponding source when redistributing.

The exact native license texts and [third-party notices](../NOTICE.md) are available in **About** and in the exported source.

Map sampling: Nearest displays sharp cells. Smooth blends display colors. Area summarizes covered values when reduced and preserves any read/write/execute activity. Hover for the exact byte and an Area summary. The 1:1 button displays one cell per physical pixel. Native sampling preferences are omitted when settings are exported again by the browser edition.

Waterfall offers independent Nearest, Smooth and Area sampling. Area combines numeric address buckets and chronological time bands before applying colors, preserving any activity and XOR change flags. Smooth blends display colors. Hover reports the original source bucket and time band. Sampling choices affect presentation and are saved independently for Map and Waterfall.

Waterfall Temporal smoothing applies a causal triangular low-pass over an adjustable 10–200 ms window. It reduces band-to-band flicker in Data, Entropy and data underlays, with a small visual lag. Activity flags retain their interval timing. Unavailable bands stay unavailable; smoothing does not add capture detail. The filter duration is independent of time-band size.

Open the Spectrogram tab between DSP and Track to view stereo audio power before the volume control, with frequency across the screen and recent time downwards. KISS FFT analyzes Hann windows at 32 kHz; FFT size and analysis interval are adjustable. Choose linear/log frequency, a 2/5/10 second window, dBFS floor/top, Nearest/Smooth/Area sampling and optional 1�200 ms temporal smoothing. Area averages linear power before conversion to dBFS. The 16 kHz upper limit follows the SPC native sample rate. Smoothing reduces flicker and trades time detail for stability.

Spectrogram renders at the physical display resolution. Balanced uses FFT 2048 / hop 256, Smooth sampling and 25 ms temporal smoothing; Transient detail uses FFT 1024 / hop 64 with temporal smoothing off; Frequency detail uses FFT 4096 / hop 256, Smooth sampling and 25 ms smoothing; Raw analysis uses FFT 2048 / hop 256, Nearest sampling and smoothing off. Manual analysis/filter changes select Custom. Larger FFTs separate nearby frequencies while spreading short events over more time; shorter hops provide more overlapping analyses. Smooth interpolates measured linear powers; it does not add audio detail.

Stereo difference is available independently of the preset. It displays the power of (Left - Right) / 2 as grayscale brightness using the same dBFS floor/top controls. Identical channels are black. Level and phase differences both contribute; opposite-phase full-scale channels reach 0 dBFS. Brightness indicates absolute difference strength, rather than a percentage of stereo difference, so faint differences remain faint at the same level range. Audio playback is unaffected. Presets, custom settings and the difference toggle are saved with native preferences.

Spectrogram analysis runs on a dedicated worker while its tab is active and the window is not minimized. Leaving the tab or minimizing the window stops spectrum capture and analysis and releases its graphics history. Returning starts fresh history at the current playback position. Direct3D 11 caches new numeric rows and scrolls the display at the selected refresh rate. Palette and level changes recolour retained data; frequency and filter changes rebuild retained rows incrementally. Filtering averages linear power before colour conversion. Visualization queues and graphics history have fixed limits; unavailable data remains marked as a gap.

Spectrogram has its own Green, Heat and Grayscale colour scales, independent of ARAM colours. Green is the default. The colour preview runs from the dBFS floor on the left to the top level on the right; its tooltip shows the limits. Stereo difference always uses grayscale brightness. Colour preferences are saved independently of analysis presets.
