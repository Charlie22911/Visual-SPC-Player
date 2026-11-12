#include "SpectrumReference.h"
#include "model/SpectrumColors.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace visual_spc {
namespace {
struct Column {
    unsigned low = 0, high = 1;
    double fraction = 0;
};
class Sampler {
    const std::deque<SpectrumRow>& rows_;
    const SpectrumReferenceConfig& config_;
    unsigned bins_;
    std::vector<std::vector<double>> filtered_;
    std::vector<uint8_t> built_, valid_;

    bool contiguous(size_t first, size_t second) const {
        return rows_[first].generation == config_.generation &&
            rows_[second].generation == config_.generation &&
            rows_[second].nativeFrame >= rows_[first].nativeFrame &&
            rows_[second].nativeFrame - rows_[first].nativeFrame == config_.hopSize;
    }
    const std::vector<double>* filteredAt(size_t endpoint) {
        if (built_[endpoint]) return valid_[endpoint] ? &filtered_[endpoint] : nullptr;
        built_[endpoint] = 1;
        const auto frame = rows_[endpoint].nativeFrame;
        if (rows_[endpoint].generation != config_.generation) return nullptr;
        auto& output = filtered_[endpoint];
        output.assign(bins_, 0);
        const uint64_t radius = config_.temporal ? uint64_t{config_.temporalMs} * 32 / config_.hopSize : 0;
        const uint64_t step = std::max(uint64_t{1}, (radius + 7) / 8);
        double norm = 0;
        for (uint64_t age = 0; age <= radius && age <= endpoint; age += step) {
            const auto& source = rows_[endpoint - static_cast<size_t>(age)];
            if (source.generation != config_.generation || frame < source.nativeFrame ||
                frame - source.nativeFrame != age * config_.hopSize) break;
            const auto& values = config_.difference ? source.difference : source.power;
            if (values.size() != bins_) break;
            const double weight = config_.temporal ?
                std::exp(-double(frame - source.nativeFrame) / (std::max(1u, config_.temporalMs) * 32.0)) : 1;
            norm += weight;
            for (unsigned bin = 0; bin < bins_; ++bin) output[bin] += values[bin] * weight;
        }
        if (!norm) return nullptr;
        for (auto& value : output) value /= norm;
        valid_[endpoint] = 1;
        return &output;
    }
public:
    Sampler(const std::deque<SpectrumRow>& rows, const SpectrumReferenceConfig& config)
        : rows_(rows), config_(config), bins_(config.fftSize / 2 + 1),
          filtered_(rows.size()), built_(rows.size()), valid_(rows.size()) {}

    bool validConfig() const {
        return config_.width && config_.height && config_.fftSize >= 2 && config_.hopSize &&
            std::isfinite(config_.seconds) && config_.seconds > 0 &&
            std::isfinite(config_.mediaFrame) && config_.mediaFrame >= 0 &&
            std::isfinite(config_.floorDb) && std::isfinite(config_.ceilingDb);
    }
    Column column(unsigned x) const {
        const auto frequency = [&](double fraction) {
            return config_.logarithmic ? 20.0 * std::pow(800.0, fraction) : 16000.0 * fraction;
        };
        const unsigned last = bins_ - 1;
        Column result;
        if (config_.sampling == 1) {
            const double bin = frequency((x + 0.5) / config_.width) * config_.fftSize / 32000;
            result.low = std::min(last, static_cast<unsigned>(std::floor(bin)));
            result.high = std::min(bins_, result.low + 2);
            result.fraction = bin - std::floor(bin);
        } else if (config_.sampling == 2) {
            result.low = std::min(last, static_cast<unsigned>(frequency(double(x) / config_.width) * config_.fftSize / 32000));
            result.high = std::clamp(static_cast<unsigned>(std::ceil(frequency(double(x + 1) / config_.width) * config_.fftSize / 32000)), result.low + 1, bins_);
        } else {
            result.low = std::min(last, static_cast<unsigned>(frequency((x + 0.5) / config_.width) * config_.fftSize / 32000 + 0.5));
            result.high = result.low + 1;
        }
        return result;
    }
    bool timeRow(unsigned y, std::vector<double>& output) {
        if (rows_.empty()) return false;
        const double duration = config_.seconds * 32000 / config_.height;
        const double end = config_.mediaFrame - y * duration;
        const double begin = end - duration;
        const auto upper = std::upper_bound(rows_.begin(), rows_.end(), end,
            [](double frame, const SpectrumRow& row) { return frame < row.nativeFrame; });
        if (upper == rows_.begin()) return false;
        const size_t endpoint = static_cast<size_t>(std::prev(upper) - rows_.begin());
        const auto& latest = rows_[endpoint];
        if (latest.generation != config_.generation || end - latest.nativeFrame > config_.hopSize * 2.0) return false;
        const auto* values = filteredAt(endpoint);
        if (!values) return false;
        output = *values;
        double norm = 1;
        if (config_.sampling == 2) {
            size_t first = endpoint;
            while (first && rows_[first - 1].nativeFrame >= begin && contiguous(first - 1, first)) --first;
            for (size_t index = first; index < endpoint; ++index) {
                const auto* previous = filteredAt(index);
                if (!previous) return false;
                for (unsigned bin = 0; bin < bins_; ++bin) output[bin] += (*previous)[bin];
                ++norm;
            }
        }
        if (config_.sampling == 1 && upper != rows_.end() &&
            upper->nativeFrame <= config_.mediaFrame && contiguous(endpoint, endpoint + 1)) {
            const double phase = std::clamp((end - latest.nativeFrame) / config_.hopSize, 0.0, 1.0);
            if (phase > 0) {
                const auto* following = filteredAt(endpoint + 1);
                if (!following) return false;
                for (unsigned bin = 0; bin < bins_; ++bin)
                    output[bin] = (1 - phase) * output[bin] + phase * (*following)[bin];
            }
        }
        if (norm != 1) for (auto& value : output) value /= norm;
        return true;
    }
    double power(const std::vector<double>& row, const Column& column) const {
        if (config_.sampling == 1 && column.high - column.low == 2)
            return row[column.low] * (1 - column.fraction) + row[column.low + 1] * column.fraction;
        double sum = 0;
        for (unsigned bin = column.low; bin < column.high; ++bin) sum += row[bin];
        return sum / (column.high - column.low);
    }
    uint32_t color(double power) const {
        const double db = 10 * std::log10(std::max(1e-12, power));
        const auto level = static_cast<unsigned>(std::clamp(
            (db - config_.floorDb) / std::max(1.0f, config_.ceilingDb - config_.floorDb) * 255, 0.0, 255.0));
        return spectrumColor(level, config_.difference ? 2 : config_.palette);
    }
};
size_t pixelCount(const SpectrumReferenceConfig& config) {
    if (config.height && config.width > std::numeric_limits<size_t>::max() / config.height)
        throw std::length_error("Spectrum reference image dimensions overflow");
    return static_cast<size_t>(config.width) * config.height;
}
void render(const std::deque<SpectrumRow>& rows, const SpectrumReferenceConfig& config,
    std::vector<uint32_t>& rgba, std::vector<double>* power, std::vector<uint8_t>* available) {
    const auto count = pixelCount(config);
    rgba.assign(count, SpectrumReferenceUnavailableColor);
    if (power) power->assign(count, 0);
    if (available) available->assign(count, 0);
    Sampler sampler(rows, config);
    if (!sampler.validConfig()) return;
    std::vector<Column> columns(config.width);
    for (unsigned x = 0; x < config.width; ++x) columns[x] = sampler.column(x);
    std::vector<double> values;
    for (unsigned y = 0; y < config.height; ++y) {
        if (!sampler.timeRow(y, values)) continue;
        for (unsigned x = 0; x < config.width; ++x) {
            const size_t index = static_cast<size_t>(y) * config.width + x;
            const double value = sampler.power(values, columns[x]);
            rgba[index] = sampler.color(value);
            if (power) (*power)[index] = value;
            if (available) (*available)[index] = 1;
        }
    }
}
}
SpectrumReferenceSample referenceSpectrumPowerAt(const std::deque<SpectrumRow>& rows,
    const SpectrumReferenceConfig& config, unsigned x, unsigned y) {
    Sampler sampler(rows, config);
    if (!sampler.validConfig() || x >= config.width || y >= config.height) return {};
    std::vector<double> values;
    if (!sampler.timeRow(y, values)) return {};
    return {sampler.power(values, sampler.column(x)), true};
}
SpectrumReferenceImage referenceSpectrum(const std::deque<SpectrumRow>& rows, const SpectrumReferenceConfig& config) {
    SpectrumReferenceImage result;
    render(rows, config, result.rgba, &result.power, &result.available);
    return result;
}
void referenceSpectrumInto(const std::deque<SpectrumRow>& rows, const SpectrumReferenceConfig& config,
    std::vector<uint32_t>& rgba) {
    render(rows, config, rgba, nullptr, nullptr);
}
}
