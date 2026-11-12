#pragma once
#include "audio/SpectrumTap.h"
#include <array>
#include <cstdint>
#include <memory>

namespace visual_spc {
struct SpectrumStamp {
    uint64_t analysisEpoch = 0;
    uint64_t rowSequence = 0;
    uint64_t endFrame = 0; // Native 32 kHz window end, exclusive.
    uint64_t segment = 0; // Changes when PCM overlap is broken.
    uint32_t generation = 0;
    uint32_t bins = 0;
};
struct SpectrumResult {
    SpectrumStamp stamp;
    std::array<float, 2049> power{};
    std::array<float, 2049> difference{};
};
using SpectrumResultQueue = SpscRing<SpectrumResult, 128>;

// Sole consumer of the native PCM queue. The audio producer never waits for it.
// The queue and its producer must outlive this worker. Results have one UI owner;
// a result pointer remains valid until that owner calls results().consume().
class SpectrumWorker {
    struct Impl;
    std::unique_ptr<Impl> impl_;
public:
    explicit SpectrumWorker(SpectrumQueue& input,bool enabled=true);
    ~SpectrumWorker();
    SpectrumWorker(const SpectrumWorker&) = delete;
    SpectrumWorker& operator=(const SpectrumWorker&) = delete;

    // UI-owner calls only. Starts at 2048/256, epoch 1. Changes supersede any
    // pending settings and apply at a packet boundary. Same settings keep their
    // epoch; unsupported settings or a stopped worker return zero.
    uint64_t configure(unsigned fftSize, unsigned hopSize);
    // UI owner: activation changes epoch and resets overlap. Inactive workers
    // wait for commands without PCM polling; production is gated at the source.
    uint64_t setActive(bool enabled);
    bool active() const noexcept;
    uint64_t appliedEpoch() const noexcept;
    SpectrumResultQueue& results() noexcept;
    // Stop/wake/join before destroying input. Safe to repeat on the UI owner.
    void stop() noexcept;
    uint64_t analysedRows() const noexcept;
    uint64_t droppedResults() const noexcept;
    uint64_t consumedPackets() const noexcept;
    uint64_t pcmHighWater() const noexcept;
    uint64_t resultHighWater() const noexcept;
    uint64_t newestFrame() const noexcept;
    uint32_t newestGeneration() const noexcept;
};
}
