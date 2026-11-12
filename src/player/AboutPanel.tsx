import { useMemo } from 'react';
import applicationLicense from '../../LICENSE?raw';
import notices from '../../NOTICE.md?raw';
import lgplLicense from '../../LICENSES/LGPL-2.1.txt?raw';
import reactLicense from '../../LICENSES/React-MIT.txt?raw';
import viteLicense from '../../LICENSES/Vite-MIT.txt?raw';
import emscriptenLicense from '../../LICENSES/Emscripten.txt?raw';
import muslLicense from '../../LICENSES/musl-COPYRIGHT.txt?raw';
import llvmLicense from '../../LICENSES/LLVM.txt?raw';
import allocatorNotice from '../../LICENSES/dlmalloc-NOTICE.txt?raw';
import fftNotice from '../../native/vendor/kissfft/COPYING?raw';
import fftLicense from '../../native/vendor/kissfft/BSD-3-Clause?raw';
import { decodeStandaloneText, getStandaloneAssets } from '../standalone';

export function AboutPanel() {
  const assets = getStandaloneAssets();
  const bundledNotices = useMemo(() => assets ? decodeStandaloneText(assets.noticesBase64) : notices, [assets]);
  const projectSourceHref = assets
    ? assets.projectSourceBase64 ? `data:application/zip;base64,${assets.projectSourceBase64}` : null
    : './Visual-SPC-Player-source.zip';
  const coreSourceHref = assets ? `data:text/plain;base64,${assets.sourceBase64}` : './spc-core-source.txt';
  return (
    <section className="detail-panel about-panel">
      <div className="section-heading"><div><span className="eyebrow">SPC700 / S-DSP</span><h2>Visual SPC Player</h2></div></div>
      <p>Local SPC audio playback and live memory, voice, DSP and audio spectrum views. Music stays on your device.</p>
      <details open>
        <summary>Usage</summary>
        <div className="about-body">
          <p><strong>Photosensitivity warning:</strong> The visualizations can produce flashing lights and rapidly changing, high-contrast patterns. If you are sensitive to these effects, please avoid using the visualizer.</p>
          <p>Choose <strong>Open folder</strong> or <strong>Open SPC files</strong> in the library. Use Play/Pause or Space to control playback and Restart to return to the beginning. Track durations are informational; playback continues until you pause or select another track.</p>
          <p>The library floats over the player. Use the folder arrow on its border to collapse or reopen it. Pin the library to reserve space beside the player. Library layout is remembered on this device.</p>
          <p>ARAM offers Activity, Data and Entropy as a Map or Waterfall, with Byte/Bit representations and optional data underlays. Scroll to zoom, drag to pan, use Fit for the full range and 1:1 for individual physical pixels. Hover to inspect captured values. Nearest keeps sharp cells, Smooth blends colors and Area summarizes covered values while preserving activity.</p>
          <p>The Spectrogram displays stereo power before the volume control, with frequency from left to right and recent audio downwards. Analysis runs while this view is active and the page is visible. Reopening it starts fresh history. FFT size trades time detail for frequency separation; smoothing reduces flicker. Stereo difference shows the power of (Left − Right) / 2 in grayscale. The upper frequency limit is 16 kHz.</p>
          <p>Voices shows the eight copied synthesizer states; DSP shows registers; Track shows ID666 metadata. Settings controls cadence, memory colors, activity persistence and diagnostics. Save settings keeps preferences in this browser; Export and Import move them between the browser and Windows application.</p>
          <p>{assets ? 'This standalone file includes the application, notices and source. Keep the HTML file to use it offline.' : 'The application prepares its files for offline use after the first visit. A standalone HTML download is also available.'}</p>
        </div>
      </details>
      <details><summary>Credits and third-party notices</summary><pre>{bundledNotices}</pre></details>
      {[
        ['Application license (MIT)', applicationLicense],
        ['snes_spc license (LGPL 2.1)', lgplLicense],
        ['React license (MIT)', reactLicense],
        ['Vite license (MIT)', viteLicense],
        ['Emscripten license', emscriptenLicense],
        ['musl notices', muslLicense],
        ['LLVM license', llvmLicense],
        ['Allocator notice', allocatorNotice],
        ['KISS FFT license (BSD 3-Clause)', fftNotice + '\n' + fftLicense],
      ].map(([title, text]) => <details key={title}><summary>{title}</summary><pre>{text}</pre></details>)}
      <details>
        <summary>Source and rebuilding</summary>
        <div className="about-body">
          <p>The application code is MIT licensed. The modified snes_spc emulator by Shay Green (blargg) is LGPL-2.1-or-later. The complete matching application, emulator, dependencies and build files are included in the source archive. Retain the applicable notices, license texts and corresponding source when redistributing. Modification and reverse engineering for debugging modifications are permitted.</p>
          <p>To rebuild the browser application, extract the source archive and install Node.js 24 or newer, the pnpm version in <code>package.json</code>, CMake, Ninja, Emscripten and Python 3.10 or newer. On Windows, the emulator build uses WSL. Run <code>pnpm install --frozen-lockfile</code> and <code>pnpm build:single</code>. Complete instructions are in <code>docs/building.md</code>; Windows application instructions are in <code>docs/windows.md</code>.</p>
          {projectSourceHref && <p><a className="source-download" href={projectSourceHref} download="Visual-SPC-Player-source.zip">Export complete source ZIP</a></p>}
          <p><a href={coreSourceHref} download="spc-core-source.txt">Export emulator source and build instructions</a></p>
        </div>
      </details>
    </section>
  );
}
