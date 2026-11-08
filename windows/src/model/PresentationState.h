#pragma once
#include "Library.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
namespace visual_spc {
class PlaybackIntent {
    bool playing_ = false, autoplay_ = false;
    uint64_t revision_ = 0, requestRevision_ = 0, request_ = 0;
public:
    bool playing() const noexcept { return playing_; }
    void setPlaying(bool playing) noexcept { playing_ = playing; ++revision_; }
    void request(uint64_t id, bool autoplay) noexcept {
        request_ = id; requestRevision_ = revision_; autoplay_ = autoplay;
    }
    void complete(uint64_t id, bool success) noexcept {
        if (id != request_) return;
        if (success && autoplay_ && requestRevision_ == revision_) playing_ = true;
        autoplay_ = false;
    }
};
class PreparedLoadState {
    uint64_t latest_ = 0;
    std::optional<LoadResult> prepared_;
public:
    uint64_t latest() const noexcept { return latest_; }
    spc_native_instance* releasePending() {
        auto* instance = prepared_ ? prepared_->instance : nullptr;
        prepared_.reset(); return instance;
    }
    spc_native_instance* begin(uint64_t id) {
        auto* retired = releasePending(); latest_ = id; return retired;
    }
    spc_native_instance* receive(LoadResult result) {
        if (result.id != latest_) return result.instance;
        auto* retired = releasePending(); prepared_ = std::move(result); return retired;
    }
    template<class Enqueue> std::optional<LoadResult> commit(Enqueue&& enqueue) {
        if (!prepared_ || prepared_->id != latest_ || !prepared_->instance ||
            !enqueue(prepared_->instance)) return std::nullopt;
        auto result = std::move(prepared_); prepared_.reset();
        result->instance = nullptr; return result;
    }
};
class MapActivityUnion {
    std::array<uint8_t, 24576> bytes_{};
    bool pending_ = false;
public:
    void reset() noexcept { bytes_.fill(0); pending_ = false; }
    void drawn() noexcept { pending_ = false; }
    void add(const std::array<uint8_t, 24576>& access) noexcept {
        if (!pending_) bytes_.fill(0);
        for (size_t i = 0; i < bytes_.size(); ++i) bytes_[i] |= access[i];
        pending_ = true;
    }
    const auto& bytes() const noexcept { return bytes_; }
};
struct PlotSampling { uint32_t columns, rows; };
class ScanSelection {
    uint64_t revision_ = 0;
public:
    void begin(uint64_t revision) noexcept { revision_ = revision; }
    void invalidate() noexcept { revision_ = 0; }
    bool accepts(uint64_t revision) const noexcept { return revision_ && revision_ == revision; }
};
inline float clampMapScale(float scale) noexcept {
    return std::isnan(scale) ? 1.0f : std::clamp(scale, 0.01f, 256.0f);
}
inline double effectiveDrawRate(double selected, bool continuous) noexcept {
    return continuous ? selected : std::min(selected, 10.0);
}
inline PlotSampling plotSampling(float width, float height, float dpiScale, bool bits, uint32_t span) {
    if (!std::isfinite(dpiScale) || dpiScale <= 0 || !span) throw std::invalid_argument("Invalid logical plot");
    const auto logicalWidth = static_cast<uint32_t>(std::max(1.0f, std::floor(width / dpiScale)));
    const auto logicalHeight = static_cast<uint32_t>(std::max(1.0f, std::floor(height / dpiScale)));
    return {std::min(span, std::max(1u, logicalWidth / (bits ? 8u : 1u))), logicalHeight};
}
inline uint32_t plotRowAt(float offset, float physicalHeight, uint32_t rows) noexcept {
    return static_cast<uint32_t>(std::clamp(std::floor(offset * rows / std::max(1.0f, physicalHeight)), 0.0f, static_cast<float>(rows - 1)));
}
inline float physicalMapScale(float logicalScale, float dpiScale) noexcept { return logicalScale * dpiScale; }
}
