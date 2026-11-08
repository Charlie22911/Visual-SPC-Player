# Windows native player

The Windows application uses C++20, Win32, WASAPI shared-mode audio, and Direct3D 11. Release builds use MSVC optimization and interprocedural optimization. The emulator runs in a replaceable `spc-native-core.dll`.

## Run

Extract the Windows ZIP and run `Visual-SPC-Player.exe`. Keep `spc-native-core.dll` beside it.

The build targets x64 Windows 10 22H2 and Windows 11 APIs. Windows 11 is the verified runtime platform. A Direct3D 11 feature-level 11_0 adapter provides hardware rendering; WARP provides a software fallback. The application uses the default Windows audio output device. A browser or separately installed application runtime is not required.

**Photosensitivity warning:** The visualizations can produce flashing lights and rapidly changing, high-contrast patterns. If you are sensitive to these effects, please avoid using the visualizer.

Choose **Open folder** to scan a library or **Open files** to select individual SPC files. You can also drop files onto the window. Music stays on your computer; no music is included in the package.

- **ARAM:** Activity, Data, and Entropy in Map or Waterfall, with Byte/Bit representations, XOR changes, and matching data underlays.
- **Navigation:** mouse wheel to zoom, drag to pan, **Fit** for the full address range, and **1:1** for individual logical pixels. Hover to inspect addresses, values, and time intervals.
- **Waterfall:** 2-, 5-, and 10-second windows, with up to ten seconds of retained captures. Time span and data underlays keep the plot height fixed. Unavailable history appears separately from zero-valued data.
- **Voices / DSP / Track:** copied voice state, DSP registers, and ID666 metadata. Track durations are informational; playback continues until you pause or select another track.
- **Settings:** palettes, 30 Hz / 60 Hz / Display cadence, activity persistence, compatible settings import/export, and byte-refresh diagnostics.

**Space** toggles playback when a text field is not active. The interface supports keyboard navigation and Windows DPI scaling. Its controls are custom rendered and do not provide full Windows UI Automation or screen-reader support.

Paused drawing slows when idle and responds to input immediately. Minimizing the window stops rendering while playback continues.

Settings are stored in `%LOCALAPPDATA%\VisualSPCPlayer\settings.json`. **Save library** stores folder or file locations in `library.json` in the same directory. Settings exports use the same version 3 format as the browser application and accept earlier version 1 and 2 exports.

## Build

Install Microsoft's **Desktop development with C++** Build Tools workload, a Windows SDK, and **C++ CMake tools for Windows**. Use CMake 3.25 or newer and Ninja.

Open an x64 Visual Studio developer command prompt in the project directory:

```text
cd windows
cmake --preset windows-x64-release
cmake --build --preset windows-x64-release
ctest --preset windows-x64-release --output-on-failure
cmake --install out/x64-release --prefix ../release/windows-x64
```

The executable and DLL are built under `windows/out/x64-release/`. The `windows-x64-debug` and `windows-x64-release-no-ipo` presets provide development configurations.

ImGui and nlohmann/json sources are vendored at the revisions recorded in their `REVISION.txt` files. The Windows SDK's FXC compiles the shaders during the build. Node.js is needed only to regenerate reference fixtures or work on the browser application.

To create the portable and matching source archives, run this from the project directory in the developer prompt with Python 3.10 or newer:

```text
python windows/tools/package.py --build-dir windows/out/x64-release
```

The archives and `SHA256SUMS` are written to `release/`. CPack can also package the installed Windows files:

```text
cpack --config windows/out/x64-release/CPackConfig.cmake -G ZIP
```

## Source organization

| Location | Purpose |
| --- | --- |
| `native/desktop_api.*` | Per-instance emulator DLL interface |
| `native/state_packet.*` | Shared, explicitly encoded snapshot packet |
| `windows/src/audio/` | WASAPI, resampling, capture scheduling, playback clock |
| `windows/src/model/` | History, reductions, settings, background file work |
| `windows/src/render/` | D3D11 device, memory shaders, numeric waterfall ring |
| `windows/src/ui/`, `windows/src/platform/` | Interface, file dialogs, Unicode paths, persistence |
| `windows/tests/`, `windows/tools/` | Native fixtures, reference exporters, packaging, benchmarks |

## Redistribution

The application code is MIT licensed. The modified snes_spc emulator by Shay Green (blargg) is LGPL-2.1-or-later. The DLL can be rebuilt and replaced using the matching source archive and the same C ABI. Retain the applicable notices, license texts, and corresponding modified emulator source when redistributing.

See [third-party notices](../NOTICE.md) and the native package's `THIRD-PARTY-NOTICES.txt`.
