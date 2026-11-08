#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
namespace visual_spc {
class Resampler {
    static constexpr std::size_t ringFrames = 32768, taps = 16, phases = 512;
    std::array<float, ringFrames> left_{}, right_{};
    std::array<float, taps * phases> coefficients_{};
    double ratio_, readPosition_ = 0;
    std::int64_t writeFrame_ = 0;
    unsigned half_;
public:
    explicit Resampler(unsigned outputRate);
    void reset() noexcept;
    std::size_t neededInputFrames(std::size_t outputFrames) const noexcept;
    bool push(const std::int16_t* interleaved, std::size_t frames) noexcept;
    std::size_t read(float* left, float* right, std::size_t capacity) noexcept;
    double sourcePosition() const noexcept { return readPosition_ - half_; }
};
}
