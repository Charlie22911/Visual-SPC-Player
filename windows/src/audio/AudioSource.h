#pragma once
#include "Resampler.h"
#include "PlaybackTimeline.h"
#include "SpectrumTap.h"
#include "model/Capture.h"
#include <array>
namespace visual_spc {
// Single audio owner. No allocation/destruction/publication waits in render().
// Handles are prepared/retired elsewhere; replace returns ownership of the old.
class AudioSource {
    spc_native_instance* active_ = nullptr;
    CaptureQueue& captures_;
    SpectrumQueue* spectrum_;
    uint32_t spectrumDiscontinuity_ = 0;
    Resampler resampler_;
    CaptureCadence cadence_{240, 1};
    std::array<int16_t, 1024> scratch_{};
    unsigned outputRate_, rampRemaining_ = 0;
    uint32_t generation_ = 0, sequence_ = 0, discontinuity_ = 0, drops_ = 0;
    uint64_t intervalBegin_ = 0;
    uint64_t sourceBase_ = 0;
    float volume_ = 0.8f, gain_ = 0, gainTarget_ = 0, gainStep_ = 0;
    bool playing_ = false;
    void ramp(float target) noexcept;
    bool capture() noexcept;
    bool feed(std::size_t frames) noexcept;
public:
    AudioSource(unsigned outputRate, CaptureQueue& captures, SpectrumQueue* spectrum = nullptr);
    spc_native_instance* replace(spc_native_instance*, uint32_t generation) noexcept;
    bool setCaptureRate(uint32_t numerator, uint32_t denominator) noexcept;
    void setPlaying(bool playing) noexcept;
    void setVolume(float volume) noexcept;
    void reconfigure(unsigned outputRate); // endpoint stopped; may allocate
    bool silent() const noexcept { return gain_ == 0 && rampRemaining_ == 0; }
    bool render(float* left, float* right, std::size_t frames) noexcept;
    struct RenderTiming {
        double sourceBegin = 0, sourceEnd = 0;
        std::size_t musicFrames = 0;
    };
    const RenderTiming& timing() const noexcept { return timing_; }
    double position() const noexcept { return sourceBase_ + resampler_.sourcePosition(); }
    uint32_t generation() const noexcept { return generation_; }
    uint32_t drops() const noexcept { return drops_; }
private:
    RenderTiming timing_{};
};
}
