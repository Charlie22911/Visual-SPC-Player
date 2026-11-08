Visual SPC Player - Windows x64

Extract the package and run Visual-SPC-Player.exe.
Keep spc-native-core.dll in the same directory.

Open folder scans a local SPC library. Open files selects individual tracks.
You can also drop files onto the window. Space toggles playback when a text
field is not active. Scroll to zoom, drag to pan, and hover to inspect.

ARAM provides Activity, Data and Entropy in Map and Waterfall views, with
Byte/Bit selection, XOR changes and matching activity backgrounds.
Settings contains refresh cadence, palettes, persistence and diagnostics.
The library's border arrow collapses or expands it. The pin button switches
between floating over the player and reserving space beside it.

Photosensitivity warning: The visualizations can produce flashing lights and
rapidly changing, high-contrast patterns. If you are sensitive to these effects,
please avoid using the visualizer.

The application targets x64 Windows 10 22H2 / Windows 11 APIs. Windows 11 is
the verified runtime platform. D3D11 feature level 11_0 provides hardware
rendering, with a software fallback. Audio uses the default Windows output.

Settings: %LOCALAPPDATA%\VisualSPCPlayer\settings.json
Saved library locations: %LOCALAPPDATA%\VisualSPCPlayer\library.json
Music stays on your computer. No music is included in this package.

The matching Windows-source ZIP contains the application, modified emulator,
vendored dependencies and build instructions in docs/windows.md.
Application source: https://github.com/Charlie22911/Visual-SPC-Player

See LICENSE.txt, THIRD-PARTY-NOTICES.txt and LICENSES/ for terms and credits.
The LGPL emulator DLL can be rebuilt and replaced using the matching source.
