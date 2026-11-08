#include "AudioSource.h"
#include <algorithm>
#include <cmath>
#include <memory>
namespace visual_spc {
AudioSource::AudioSource(unsigned rate, CaptureQueue& captures)
    : captures_(captures), resampler_(rate), outputRate_(rate) { cadence_.reset(0); }
void AudioSource::ramp(float target) noexcept {
    gainTarget_ = target;
    if (gain_ == target) { rampRemaining_ = 0; gainStep_ = 0; return; }
    rampRemaining_ = std::max(1u, outputRate_ * 8 / 1000);
    gainStep_ = (target - gain_) / static_cast<float>(rampRemaining_);
}
void AudioSource::setPlaying(bool playing) noexcept {
    playing_ = playing; ramp(playing ? volume_ : 0);
}
void AudioSource::setVolume(float volume) noexcept {
    if (!std::isfinite(volume)) return;
    volume_ = std::clamp(volume, 0.0f, 1.0f);
    ramp(playing_ ? volume_ : 0);
}
spc_native_instance* AudioSource::replace(spc_native_instance* prepared, uint32_t generation) noexcept {
    auto* old = active_; active_ = prepared; generation_ = generation;
    sequence_ = discontinuity_ = 0;
    sourceBase_ = intervalBegin_ = spc_native_generated_frames(active_);
    resampler_.reset(); cadence_.reset(sourceBase_); gain_ = 0; ramp(playing_ ? volume_ : 0);
    if (active_) capture();
    return old;
}
void AudioSource::reconfigure(unsigned rate) {
    auto replacement = std::make_unique<Resampler>(rate);
    resampler_ = std::move(*replacement); outputRate_ = rate;
    sourceBase_ = intervalBegin_ = spc_native_generated_frames(active_);
    cadence_.reset(sourceBase_); ++discontinuity_; gain_ = 0;
    ramp(playing_ ? volume_ : 0);
    if (active_) capture();
}
bool AudioSource::setCaptureRate(uint32_t numerator, uint32_t denominator) noexcept {
    if (!numerator || !denominator || numerator > 32000ull * denominator) return false;
    cadence_ = CaptureCadence(numerator, denominator);
    cadence_.reset(spc_native_generated_frames(active_));
    return true;
}
bool AudioSource::capture() noexcept {
    auto* slot = captures_.producer_slot();
    if (!slot) { ++drops_; ++discontinuity_; ++sequence_; return true; }
    const auto frame = spc_native_generated_frames(active_);
    if (spc_native_capture(active_, slot->ram.data(), SPC_NATIVE_ARAM_BYTES,
        slot->access.data(), SPC_NATIVE_ACTIVITY_BYTES, slot->state.data(),
        SPC_NATIVE_STATE_BYTES, generation_, sequence_) != SPC_NATIVE_OK) return false;
    slot->nativeFrame = frame; slot->intervalBegin = intervalBegin_;
    slot->generation = generation_; slot->sequence = sequence_++;
    slot->discontinuity = discontinuity_;
    intervalBegin_ = frame; captures_.publish();
    return true;
}
bool AudioSource::feed(std::size_t requested) noexcept {
    while (requested) {
        const auto generated = spc_native_generated_frames(active_);
        if (generated == cadence_.next()) {
            if (!capture()) return false;
            cadence_.advance(); continue;
        }
        const auto count = static_cast<uint32_t>(std::min<uint64_t>(
            requested, std::min<uint64_t>(512, cadence_.next() - generated)));
        if (!count || spc_native_render(active_, scratch_.data(), count) != SPC_NATIVE_OK ||
            !resampler_.push(scratch_.data(), count)) return false;
        requested -= count;
    }
    if (spc_native_generated_frames(active_) == cadence_.next()) {
        if (!capture()) return false;
        cadence_.advance();
    }
    return true;
}
bool AudioSource::render(float* left, float* right, std::size_t frames) noexcept {
    if (!left || !right || frames > 2048) return false;
    timing_ = {position(), position(), 0};
    std::fill_n(left, frames, 0.0f); std::fill_n(right, frames, 0.0f);
    if (!active_) return true;
    const auto music = playing_ ? frames : std::min<std::size_t>(frames, rampRemaining_);
    if (!music) return true;
    if (!feed(resampler_.neededInputFrames(music)) ||
        resampler_.read(left, right, music) != music) return false;
    timing_.musicFrames = music; timing_.sourceEnd = position();
    for (std::size_t i = 0; i < music; ++i) {
        if (rampRemaining_) {
            gain_ += gainStep_;
            if (!--rampRemaining_) gain_ = gainTarget_;
        }
        left[i] *= gain_; right[i] *= gain_;
    }
    return true;
}
}
