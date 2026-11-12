Visual SPC Player - Windows x64

Run Visual-SPC-Player.exe. All application code, usage, license texts and
complete matching source are included in this single executable.

Open folder scans a local SPC library. Open files selects individual tracks.
You can also drop files onto the window. Space toggles playback when a text
field is not active. Scroll to zoom, drag to pan, and hover to inspect.
Hover over the Play/Pause and Restart symbols to see their labels.

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

About contains collapsible usage, credits, licenses and source sections.
Open Source and rebuilding to export the complete matching source ZIP.
The source includes the application, modified emulator, dependencies,
and build instructions in docs/windows.md.
Application source: https://github.com/Charlie22911/Visual-SPC-Player

See the About license and credits sections for terms and attribution.
The application and LGPL emulator can be modified, rebuilt and relinked
using the included source. Modification and reverse engineering for debugging
modifications are permitted.

Map sampling: Nearest displays sharp cells. Smooth blends display colors. Area summarizes covered values when reduced and preserves any read/write/execute activity. Hover for the exact byte and an Area summary. The 1:1 button displays one cell per physical pixel. Native sampling preferences are omitted when settings are exported again by the browser edition.

Waterfall offers independent Nearest, Smooth and Area sampling. Area combines numeric address buckets and chronological time bands before applying colors, preserving any activity and XOR change flags. Smooth blends display colors. Hover reports the original source bucket and time band. Sampling choices affect presentation and are saved independently for Map and Waterfall.

Waterfall Temporal smoothing applies a causal triangular low-pass over an adjustable 10â€“200 ms window. It reduces band-to-band flicker in Data, Entropy and data underlays, with a small visual lag. Activity flags retain their interval timing. Unavailable bands stay unavailable; smoothing does not add capture detail. The filter duration is independent of time-band size.

Open the Spectrogram tab between DSP and Track to view stereo audio power before the volume control, with frequency across the screen and recent time downwards. KISS FFT analyzes Hann windows at 32 kHz; FFT size and analysis interval are adjustable. Choose linear/log frequency, a 2/5/10 second window, dBFS floor/top, Nearest/Smooth/Area sampling and optional 1–200 ms temporal smoothing. Area averages linear power before conversion to dBFS. The 16 kHz upper limit follows the SPC native sample rate. Smoothing reduces flicker and trades time detail for stability.

Spectrogram renders at the physical display resolution. Balanced uses FFT 2048 / hop 256, Smooth sampling and 25 ms temporal smoothing; Transient detail uses FFT 1024 / hop 64 with temporal smoothing off; Frequency detail uses FFT 4096 / hop 256, Smooth sampling and 25 ms smoothing; Raw analysis uses FFT 2048 / hop 256, Nearest sampling and smoothing off. Manual analysis/filter changes select Custom. Larger FFTs separate nearby frequencies while spreading short events over more time; shorter hops provide more overlapping analyses. Smooth interpolates measured linear powers; it does not add audio detail.

Stereo difference is available independently of the preset. It displays the power of (Left - Right) / 2 as grayscale brightness using the same dBFS floor/top controls. Identical channels are black. Level and phase differences both contribute; opposite-phase full-scale channels reach 0 dBFS. Brightness indicates absolute difference strength, rather than a percentage of stereo difference, so faint differences remain faint at the same level range. Audio playback is unaffected. Presets, custom settings and the difference toggle are saved with native preferences.

Spectrogram analysis runs on a dedicated worker while its tab is active and the window is not minimized. Leaving the tab or minimizing the window stops spectrum capture and analysis and releases its graphics history. Returning starts fresh history at the current playback position. Direct3D 11 caches new numeric rows and scrolls the display at the selected refresh rate. Palette and level changes recolour retained data; frequency and filter changes rebuild retained rows incrementally. Filtering averages linear power before colour conversion. Visualization queues and graphics history have fixed limits; unavailable data remains marked as a gap.

Spectrogram has its own Green, Heat and Grayscale colour scales, independent of ARAM colours. Green is the default. The colour preview runs from the dBFS floor on the left to the top level on the right; its tooltip shows the limits. Stereo difference always uses grayscale brightness. Colour preferences are saved independently of analysis presets.
