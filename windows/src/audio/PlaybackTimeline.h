#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <cmath>
namespace visual_spc {
class CaptureCadence {
    std::uint64_t numerator_, denominator_, remainder_ = 0, next_ = 0;
public:
    CaptureCadence(std::uint32_t rateNum, std::uint32_t rateDen)
        : numerator_(32000ull * rateDen), denominator_(rateNum) {
        if (!rateNum || !rateDen || rateNum > numerator_) throw std::invalid_argument("Invalid capture rate");
    }
    void reset(std::uint64_t generated) noexcept { remainder_ = 0; next_ = generated; advance(); }
    std::uint64_t next() const noexcept { return next_; }
    void advance() noexcept {
        remainder_ += numerator_; next_ += remainder_ / denominator_; remainder_ %= denominator_;
    }
};
struct PlaybackSegment {
    std::uint64_t outputEpoch, outputBegin, outputEnd;
    std::uint32_t generation;
    double sourceBegin, sourceStep;
};
struct MediaPosition { std::uint32_t generation; double sourceFrame; };
class PlaybackTimeline {
    std::array<PlaybackSegment, 512> segments_{};
    std::size_t begin_ = 0, count_ = 0;
public:
    void reset() noexcept { begin_ = count_ = 0; }
    bool append(const PlaybackSegment& s) noexcept {
        if (s.outputBegin >= s.outputEnd || !std::isfinite(s.sourceBegin) ||
            !std::isfinite(s.sourceStep) || s.sourceBegin < 0 || s.sourceStep < 0) return false;
        if (count_) {
            auto& previous = segments_[(begin_ + count_ - 1) % segments_.size()];
            if (previous.outputEpoch != s.outputEpoch || previous.outputEnd != s.outputBegin) return false;
            const auto nextSource = previous.sourceBegin + static_cast<double>(previous.outputEnd - previous.outputBegin) * previous.sourceStep;
            if (previous.generation == s.generation && previous.sourceStep == s.sourceStep &&
                nextSource == s.sourceBegin) { previous.outputEnd = s.outputEnd; return true; }
        }
        if (count_ == segments_.size()) return false;
        segments_[(begin_ + count_++) % segments_.size()] = s;
        return true;
    }
    std::optional<MediaPosition> at(std::uint64_t epoch, double frame) const noexcept {
        for (std::size_t i = 0; i < count_; ++i) {
            const auto& s = segments_[(begin_ + i) % segments_.size()];
            if (s.outputEpoch == epoch && frame >= static_cast<double>(s.outputBegin) &&
                frame < static_cast<double>(s.outputEnd))
                return MediaPosition{s.generation, s.sourceBegin + (frame - static_cast<double>(s.outputBegin)) * s.sourceStep};
        }
        return std::nullopt;
    }
    std::optional<PlaybackSegment> segmentAt(std::uint64_t epoch, double frame) const noexcept {
        for (std::size_t i = 0; i < count_; ++i) {
            const auto& s = segments_[(begin_ + i) % segments_.size()];
            if (s.outputEpoch == epoch && frame >= static_cast<double>(s.outputBegin) &&
                frame < static_cast<double>(s.outputEnd)) return s;
        }
        return std::nullopt;
    }
    unsigned unplayedGenerations(std::uint64_t epoch, double playedFrame) const noexcept {
        unsigned count = 0;
        std::optional<std::uint32_t> last;
        for (std::size_t i = 0; i < count_; ++i) {
            const auto& s = segments_[(begin_ + i) % segments_.size()];
            if (s.outputEpoch != epoch || static_cast<double>(s.outputEnd) <= playedFrame) continue;
            if (!last || *last != s.generation) { ++count; last = s.generation; }
        }
        return count;
    }
    void retireBefore(std::uint64_t epoch, double playedFrame) noexcept {
        while (count_ > 1) {
            const auto& s = segments_[begin_];
            if (s.outputEpoch == epoch && static_cast<double>(s.outputEnd) > playedFrame) break;
            begin_ = (begin_ + 1) % segments_.size(); --count_;
        }
    }
};
}
