# Contributing

I welcome focused fixes and improvements to Visual SPC Player. Before starting a substantial change, open an issue describing the behavior and the proposed approach.

## Development

Follow [docs/building.md](docs/building.md) for the browser build or [docs/windows.md](docs/windows.md) for the native Windows build. Keep emulation on the browser worklet or Windows audio thread, and present copied snapshots to the interface.

Run `pnpm test` and `pnpm typecheck` for application changes. Rebuild and run the native, WebAssembly, and protocol checks when changing the audio core or its ABI. For interface and renderer changes, run the relevant browser checks at desktop and phone sizes.

## Bug reports and pull requests

Include the browser, operating system, selected view, refresh setting, and steps to reproduce. Describe the resulting behavior and the checks you ran. Use generated fixtures where possible; do not attach music files without permission to distribute them.

Keep generated builds out of commits. Retain third-party copyright notices and update build instructions when dependencies or commands change.
