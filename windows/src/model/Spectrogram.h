#pragma once
#include "audio/SpectrumTap.h"
#include <deque>
#include <memory>
#include <span>
#include <vector>
namespace visual_spc {
struct SpectrumRow {
    uint32_t generation = 0;
    uint64_t nativeFrame = 0; // Window end, exclusive; gate against audible media time.
    // Linear, Hann coherent-gain-corrected, one-sided peak amplitude squared.
    // Stereo channels are transformed separately and their powers averaged.
    // A bin-centred full-scale sine in both channels reads 1 (0 dBFS).
    // Convert with 10*log10(max(power, displayFloor)); DC/Nyquist are not doubled.
    std::vector<float> power;
    // Phase-sensitive stereo difference: calibrated power of (left-right)/2.
    // Equal channels read zero; opposite full-scale channels read 1 (0 dBFS).
    std::vector<float> difference;
};
// Valid only during the sink call; storage is reused for the next transform.
struct SpectrumFrameView {
    uint32_t generation;
    uint64_t nativeFrame, segment;
    std::span<const float> power, difference;
};
// Single-owner analysis. No analysis or allocation takes place on the audio owner.
class Spectrogram {
    struct Impl;
    std::unique_ptr<Impl> impl_;
public:
    using RowSink = void (*)(void* context, const SpectrumFrameView& row) noexcept;
    static constexpr unsigned SampleRate = 32000, FftSize = 2048, HopSize = 256;
    static constexpr unsigned MaxRows = SampleRate * 10 / HopSize;
    Spectrogram();
    // A sink selects streaming mode: rows() stays empty and no history payload
    // is allocated. The context must outlive the analyser. A null sink keeps the
    // default bounded-history mode.
    Spectrogram(RowSink sink, void* context);
    ~Spectrogram();
    Spectrogram(const Spectrogram&) = delete;
    Spectrogram& operator=(const Spectrogram&) = delete;
    // Supported FFT sizes: 1024/2048/4096; hops: 64/128/256/512.
    // A changed configuration clears history and overlap, retaining generation.
    // Unchanged configurations are a no-op; unsupported values return false.
    bool configure(unsigned fftSize, unsigned hopSize);
    unsigned fftSize() const noexcept;
    unsigned hopSize() const noexcept;
    unsigned binCount() const noexcept;
    void reset(uint32_t generation);
    // Gaps reset overlapping input, preserving history without synthesizing rows.
    // Old-generation and malformed packets are ignored. A new generation resets.
    bool ingest(const SpectrumPacket& packet);
    const std::deque<SpectrumRow>& rows() const noexcept;
};
}
