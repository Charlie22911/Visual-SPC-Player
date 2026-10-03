# Architecture

The application keeps decoding, audio timing, and mutable emulator state off the React thread.

    local SPC file
          |
          v
    React library and transport
          | transferable ArrayBuffer
          v
    AudioWorklet + standalone WebAssembly
          | 32 kHz stereo PCM
          v
    16-tap windowed-sinc resampler -> device output
          |
          +-> copied ARAM, activity, DSP, and voice snapshots
                         |
                         v
                    Canvas renderer

The AudioWorklet is the sole owner of the active emulator. Loading prepares a staging instance and commits it after a short fade boundary, so the main thread never reads live emulator storage. Playback state is published through versioned, acknowledged messages. The worklet reuses three transferable snapshot buffers. The engine copies each accepted snapshot into UI-owned storage and immediately returns the transferable, so React never retains a buffer that the worklet can detach.

## WebAssembly boundary

`native/web_api.h` defines the stable C ABI. It exposes initialization, prepare/commit, rendering, copied ARAM, drained activity, copied DSP/voice state, frame count, generation, and disposal. The Emscripten target uses fixed 64 MiB memory and has no filesystem or networking dependency.

The state packet is 288 bytes:

- bytes 0-23: ABI version, length, generation, sequence, validity flags, and reserved header fields
- bytes 24-31: native rendered frame count as a little-endian double
- bytes 32-159: all 128 DSP registers
- bytes 160-287: eight 16-byte voice records

## ARAM semantics

The ARAM view contains 65,536 emulator-visible bytes. The final 64 addresses may display the SPC700 IPL ROM overlay when that overlay is active. The copy API cannot mutate emulator state.

The measurement selector offers Activity, Data, and Entropy, each with an independent byte/bit choice. Data also has an XOR control. Map presents byte representations at `x = a & 255`, `y = a >> 8`, producing a 256 × 256 image.

Bit representations use a 1,024 × 512 image, including Activity, XOR, and per-bit entropy. Each byte has a 4 × 2 tile at `tileX = (a & 255) * 4`, `tileY = (a >> 8) * 2`. The top row contains bits 7, 6, 5, 4 and the bottom row contains bits 3, 2, 1, 0. Activity remains an address-level measurement and repeats the same access kind across all eight bit positions.

Activity counters cover one bit per ARAM address for reads, writes, and execution since the previous capture. The worklet copies ARAM and drains activity synchronously, without rendering audio between those operations. Each bitmap describes access during the interval ending at its paired ARAM capture; it does not record the value returned by every individual access. Map can retain activity for the selected persistence duration, including overlays on byte and bit maps. Plain Waterfall Activity ORs access kinds over address buckets and time bands. Overlapping channels blend without changing emulation.

**Show bytes underneath** and **Show bits underneath** use background colors at 35% brightness and activity colors at 92% opacity, flattened into opaque pixels. Map retains all access flags from coalesced audio callbacks in the displayed interval and uses its ending ARAM state, with persistence bypassed. Waterfall ORs access kinds over the whole time band and uses the latest byte means or per-bit occupancy fractions in that band. Both Activity representations preserve the same access coverage; selecting a background does not discard intermediate accesses. Palette changes, pause, and zoom rebuild from the stored intervals. Inspection uses the same reduction as the pixels. The shared background setting keeps the portable field name `activityByteBackground`; `activityUnit` selects which background it displays and defaults to `byte` when absent from older settings files.

All live panels subscribe to presented snapshots at the shared `VisualStream.publish()` boundary. General React state updates are limited to 10 Hz, while ARAM, Voices, and DSP follow the selected 30 Hz, 60 Hz, or measured display cadence. Measurement, geometry, palette, zoom, and waterfall time span are client-side presentation choices and do not request a different emulator stream.

## Memory history and Waterfall

The presentation queue keeps original snapshot payloads intact and creates a separate 24,576-byte access union when combining queued samples. All Activity presentations use this union with the ending ARAM capture to cover the complete displayed interval. Before each stream publication, `MemoryHistory` copies the complete 90,400-byte snapshot and its access union into owned storage. A chronological queue retains every presented state for the maximum 10-second window and the sample at or before its cutoff, preserving the oldest visible XOR baseline. Each record uses 114,976 payload bytes, allocated lazily. At 240 captures per second, this is approximately 275 MB. Expired storage is recycled, with up to two spare buffers retained for cadence jitter; excess buffers are released when the capture rate falls. Each record has a monotonic ID, generation, request ID, native frame count, audible frame count, and predecessor ID. Reset releases payload storage but does not reuse IDs. Consumers retain IDs and resolve records again after eviction.

Waterfall uses audible frames at 32,000 Hz for time. The interval between consecutive continuous samples is `(previous,current]`. A request change, discarded queue data, or an interval longer than 250 ms breaks continuity. Repeated audible timestamps do not add rows; an increasing audible timestamp can add a row even when the native frame count repeats. Failed replacement loads preserve current playback history; successful loads and restarts reset it.

The plot uses integer, half-open address windows. For `C` address buckets, bucket `x` covers `[start + floor(x*span/C), start + floor((x+1)*span/C))`. Buckets partition the visible range exactly. Bits gives each bucket eight horizontal logical pixels, ordered bit 7 through bit 0; other measurements use one pixel per bucket. Zoom stops at one byte per bucket, giving one pixel per bit in Bits. Every vertical pixel represents one time band in all measurements. DPR changes only the displayed canvas resolution. Resizing manual zoom or switching measurements preserves the center and bytes per bucket, while Fit continues to cover all 65,536 addresses.

| Measurement | Address reduction | Time-band reduction |
| --- | --- | --- |
| Activity | OR read/write/execute kinds | OR kinds |
| Activity with bytes underneath | Interval access kinds ORed within the bucket, plus mean ending byte values | OR kinds and latest sampled byte values |
| Activity Bit | OR read/write/execute kinds, repeated over eight horizontal bit positions | OR kinds |
| Activity with bits underneath | Interval access kinds ORed within the bucket, plus ending set fraction for each bit position | OR kinds and latest sampled bit fractions |
| Byte values | Arithmetic mean | Latest sampled value |
| Bits | Fraction set for each bit, ordered 7 through 0 horizontally within each bucket | Latest sampled value |
| Data Byte with XOR | Mean of raw XOR masks (0–255), plus an any-change flag | OR masks at each address across the band before address reduction |
| Data Bit with XOR | Changed fraction for each bit position | OR masks at each address across the band before address reduction |
| Entropy Byte | Weighted mean of aligned 256-byte block entropies (0–8) | Latest sampled value |
| Entropy Bit | Weighted mean of each bit position's entropy in aligned 256-byte blocks (0–1) | Latest sampled value |

Byte entropy is Shannon entropy over byte frequencies, from 0 to 8 bits per byte. Bit entropy computes `-p log2(p) - (1-p) log2(1-p)` independently for positions 7 through 0, where `p` is the fraction of bytes with that bit set. A fixed position gives 0, and an equally split position gives 1. Both analysis windows remain 256 bytes at every zoom; a single-byte bucket shows values for the containing block. Numeric rulers and hover/tap readings expose the measurements. These spatial frequency measures do not identify randomness, code, or audio samples.

XOR requires a continuous retained predecessor. Map uses `current[a] ^ previous[a]`, rendered as a byte value or eight changed-bit indicators. Waterfall ORs all available consecutive XOR masks per address within a band before spatial averaging; this retains observed changes that reverse within that band. Changes that reverse between captures cannot be observed. Missing coverage and unavailable baselines use the gap color rather than a valid zero value.

`WaterfallRenderer` keeps a plot-sized logical canvas, shifts completed bands with a self-blit, and recomposes intervals touched by new records. Parameter changes rebuild from newest data first in cancellable animation-frame chunks. The per-chunk target is `min(4,500/displayHz)` milliseconds; one band can exceed that target. Reduced numeric rows and entropy blocks use a 16 MiB LRU cache, keyed by the byte or bit calculation as well as record ID. XOR bands combine raw masks before reduction; evicted predecessors cannot be recovered from cached results. Inspection overlays do not repaint the history canvas.

## Audio

The core renders native 32,000 Hz stereo PCM. A stateful 16-tap, 512-phase windowed-sinc converter produces the browser device rate. At exactly 32,000 Hz, audio passes through directly. Pause and restart transitions use short gain ramps to avoid discontinuities.

## Library and privacy

A selected directory is enumerated recursively when the File System Access API is available. File handles remain lazy until a track is selected, scans report progress and can be canceled, and the library offers folder navigation plus paging for large collections. Other browsers use the standard directory input fallback. Only case-insensitive `.spc` entries enter the library, with stable session/path identifiers and natural path sorting. The service worker verifies and caches one complete content-addressed release; it never adds selected music to its cache.
