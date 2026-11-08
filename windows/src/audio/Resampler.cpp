#include "Resampler.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace visual_spc {
Resampler::Resampler(unsigned rate) : ratio_(32000.0 / rate), half_(rate == 32000 ? 0u : 8u) {
    if (rate < 8000 || rate > 384000) throw std::invalid_argument("Unsupported device sample rate");
    constexpr double pi = 3.14159265358979323846;
    const auto cutoff = std::min(1.0, rate / 32000.0) * 0.94;
    for (std::size_t phase = 0; phase < phases; ++phase) {
        double sum = 0;
        for (std::size_t tap = 0; tap < taps; ++tap) {
            const double offset = static_cast<double>(tap) - 8 + 1 - static_cast<double>(phase) / phases;
            const double scaled = pi * cutoff * offset;
            const double sinc = std::abs(scaled) < 1e-9 ? 1 : std::sin(scaled) / scaled;
            const double window = std::abs(offset) >= 8 ? 0 : 0.5 + 0.5 * std::cos(pi * offset / 8);
            const double coefficient = cutoff * sinc * window;
            coefficients_[phase * taps + tap] = static_cast<float>(coefficient);
            sum += coefficient;
        }
        for (std::size_t tap = 0; tap < taps; ++tap)
            coefficients_[phase * taps + tap] = static_cast<float>(coefficients_[phase * taps + tap] / sum);
    }
    reset();
}
void Resampler::reset() noexcept {
    left_.fill(0); right_.fill(0); writeFrame_ = half_; readPosition_ = half_;
}
std::size_t Resampler::neededInputFrames(std::size_t frames) const noexcept {
    if (!frames) return 0;
    // Match read()'s additions exactly: multiplication can round to the other
    // side of an integer boundary and under-advertise required input. Preserve
    // the browser's FIR phase selection; device requests are bounded blocks.
    auto last = readPosition_;
    for (std::size_t i = 1; i < frames; ++i) last += ratio_;
    const auto required = static_cast<std::int64_t>(std::floor(last)) + half_ + 1;
    return required > writeFrame_ ? static_cast<std::size_t>(required - writeFrame_) : 0;
}
bool Resampler::push(const std::int16_t* input, std::size_t frames) noexcept {
    const auto oldest = static_cast<std::int64_t>(std::floor(readPosition_)) - half_ - 1;
    if ((!input && frames) || frames > ringFrames ||
        writeFrame_ - oldest + static_cast<std::int64_t>(frames) > static_cast<std::int64_t>(ringFrames)) return false;
    for (std::size_t i = 0; i < frames; ++i, ++writeFrame_) {
        const auto slot = static_cast<std::size_t>(writeFrame_) & (ringFrames - 1);
        left_[slot] = input[2 * i] / 32768.0f; right_[slot] = input[2 * i + 1] / 32768.0f;
    }
    return true;
}
std::size_t Resampler::read(float* left, float* right, std::size_t capacity) noexcept {
    std::size_t count = 0;
    while (count < capacity && neededInputFrames(1) == 0) {
        const auto center = static_cast<std::int64_t>(std::floor(readPosition_));
        if (!half_) {
            const auto slot = static_cast<std::size_t>(center) & (ringFrames - 1);
            left[count] = left_[slot]; right[count] = right_[slot];
        } else {
            const auto phase = std::min(phases - 1, static_cast<std::size_t>(
                std::floor((readPosition_ - static_cast<double>(center)) * phases + 0.5)));
            double l = 0, r = 0;
            for (std::size_t tap = 0; tap < taps; ++tap) {
                const auto slot = static_cast<std::size_t>(center + static_cast<std::int64_t>(tap) - 7) & (ringFrames - 1);
                const double c = coefficients_[phase * taps + tap];
                l += left_[slot] * c; r += right_[slot] * c;
            }
            left[count] = static_cast<float>(l); right[count] = static_cast<float>(r);
        }
        readPosition_ += ratio_; ++count;
    }
    return count;
}
}
