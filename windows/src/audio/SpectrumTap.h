#pragma once
#include "concurrency/SpscRing.h"
#include <array>
#include <cstdint>
namespace visual_spc {
// Native 32 kHz PCM, before output resampling, playback gain and mute.
// The producer drops a packet when full; nativeFrame exposes the resulting gap.
struct SpectrumPacket {
    uint32_t generation = 0, discontinuity = 0;
    uint64_t nativeFrame = 0; // First frame, inclusive.
    uint32_t frameCount = 0;
    std::array<int16_t, 1024> pcm{}; // Up to 512 interleaved stereo frames.
};
class SpectrumQueue : public SpscRing<SpectrumPacket,256> {
    std::atomic<uint64_t> dropped_{0};
    std::atomic<bool> captureEnabled_{true};
public:
    void setCaptureEnabled(bool enabled) noexcept { captureEnabled_.store(enabled,std::memory_order_release); }
    bool captureEnabled() const noexcept { return captureEnabled_.load(std::memory_order_acquire); }
    void recordDrop() noexcept { dropped_.fetch_add(1,std::memory_order_relaxed); }
    uint64_t dropped() const noexcept { return dropped_.load(std::memory_order_relaxed); }
};
}
