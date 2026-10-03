# Standalone HTML build

`Visual-SPC-Player.html` is the portable build. Its interface, styles, SPC audio worklet, WebAssembly emulator, license notices, and native core build sources are embedded in that one file. It does not fetch application files from the internet.

## Open and use it

1. Copy `Visual-SPC-Player.html` to the device that will run it.
2. Open that file in a browser. Local-file AudioWorklet restrictions vary by browser; if audio initialization fails, try a Chromium-based browser or serve a production build over localhost or HTTPS.
3. Choose an SPC file or folder. The music remains on the device.
4. If the browser suspends audio, use **Resume audio**. If initialization fails, use **Retry audio initialization** after opening the file in a supported browser.

The normal `index.html` is the development entry page and still requires the local server. It is not the portable build.

## Saved settings and libraries

**Save settings** and **Save library** use the browser's storage for the local file origin. Availability and retention depend on the browser. Export settings to JSON when a portable backup is needed.

Saved directory handles may require permission again after reopening the page. Some browsers cannot persist directory handles from local files; the app reports this beside the library controls without blocking playback.

## Update it

Replace the old `Visual-SPC-Player.html` with a newly built copy. The Settings diagnostics show a standalone build identifier so two copies can be compared. A standalone file does not use the hosted app's service-worker update button.

## Build it

Run the full build and release packager:

    pnpm build:release

The packager fails if the application has more than one main script or stylesheet, retains a dynamic import, references a stylesheet asset outside the document, cannot identify the exact compiled SPC worklet, or finds unresolved imports in that worklet. The standalone file is written to the project root as `Visual-SPC-Player.html`, then copied to `release/v<version>/` alongside a SHA-256 checksum. Generated files are excluded from Git; the organized source remains in the repository.

## Manual compatibility checklist

- Open the file directly from disk and confirm there are no missing application assets.
- Select one SPC file, begin playback, pause, resume, and restart.
- Confirm Activity, Data, and Entropy update in both Byte and Bit representations, with matching Activity backgrounds and Data XOR.
- Open a nested folder library and navigate through its subfolders.
- Save and restore settings. Export settings, change a setting, then import the exported file.
- Save a library, close the tab, reopen the same standalone file, and restore the library.
- Disconnect networking and repeat file selection and playback.
- Check Settings for a clear audio state, offline status, and standalone build identifier.
