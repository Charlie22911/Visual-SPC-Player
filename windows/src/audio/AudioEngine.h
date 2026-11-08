#pragma once
#include "model/Capture.h"
#include <memory>
namespace visual_spc {
struct ClockAnchor {
    uint64_t epoch = 0, qpc100ns = 0;
    uint32_t generation = 0, rate = 0, drops = 0;
    double mediaFrame = 0, sourceStep = 0, remainingDeviceFrames = 0;
    uint32_t periodFrames = 0, bufferFrames = 0, channels = 0, bits = 0;
    bool floating = false;
};
class AudioEngine {
    struct Impl;
    std::unique_ptr<Impl> impl_;
public:
    AudioEngine();
    ~AudioEngine();
    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;
    // All commands/pop methods have one UI-side caller. Success transfers
    // ownership of a prepared handle. Drain retired handles on the worker.
    bool replace(spc_native_instance* prepared, uint32_t generation);
    bool setPlaying(bool playing);
    bool setVolume(float volume);
    bool setCaptureRate(uint32_t numerator, uint32_t denominator);
    bool popRetired(spc_native_instance*& instance);
    bool popAnchor(ClockAnchor& anchor);
    CaptureQueue& captures() noexcept;
    unsigned sampleRate() const noexcept;
    long lastError() const noexcept;
};
}
