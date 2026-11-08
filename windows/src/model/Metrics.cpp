#include "Metrics.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace visual_spc {
std::pair<uint32_t, uint32_t> bucketRange(uint32_t start, uint32_t span, uint32_t columns, uint32_t x) {
    if (!columns || columns > span || !span || span > 65536 || start > 65536 - span || x >= columns)
        throw std::invalid_argument("Invalid address buckets");
    return {start + static_cast<uint32_t>(uint64_t(x) * span / columns),
        start + static_cast<uint32_t>(uint64_t(x + 1) * span / columns)};
}
Metrics::Metrics() {
    for (unsigned i = 1; i <= 256; ++i) countLog_[i] = i * std::log2(i);
    for (unsigned i = 1; i < 256; ++i) {
        const double p = i / 256.0;
        binary_[i] = static_cast<float>(-p * std::log2(p) - (1 - p) * std::log2(1 - p));
    }
}
std::vector<float> Metrics::entropy(const std::array<uint8_t, 65536>& ram, bool bits) const {
    std::vector<float> output(bits ? 2048 : 256);
    for (unsigned block = 0; block < 256; ++block) {
        std::array<unsigned, 256> counts{};
        std::array<unsigned, 8> bitCounts{};
        for (unsigned a = block * 256; a < (block + 1) * 256; ++a) {
            ++counts[ram[a]];
            if (bits) for (unsigned lane = 0; lane < 8; ++lane) bitCounts[lane] += (ram[a] >> (7 - lane)) & 1;
        }
        if (bits) for (unsigned lane = 0; lane < 8; ++lane) output[lane * 256 + block] = binary_[bitCounts[lane]];
        else {
            double sum = 0; for (const auto count : counts) sum += countLog_[count];
            output[block] = static_cast<float>(std::clamp(8 - sum / 256, 0.0, 8.0));
        }
    }
    return output;
}
ReducedRow Metrics::reduce(const HistoryRecord& record, const HistoryRecord* previous, const ViewConfig& config) const {
    const unsigned lanes = config.bits ? 8 : 1;
    // Validate all dimensions before sizing buffers.
    bucketRange(config.start, config.span, config.columns, 0);
    ReducedRow row;
    row.values.resize(config.columns * lanes);
    row.anyChange.resize(config.columns * lanes);
    row.recordId = record.id;
    const bool xorMode = config.measurement == Measurement::Data && config.changesOnly;
    row.valid = !xorMode || previous;
    if (!row.valid) return row;
    if (config.measurement == Measurement::Activity && config.underlay) row.background.resize(row.values.size());
    const auto entropies = config.measurement == Measurement::Entropy ? entropy(record.ram, config.bits) : std::vector<float>{};
    for (unsigned x = 0; x < config.columns; ++x) {
        const auto [begin, end] = bucketRange(config.start, config.span, config.columns, x);
        const double count = end - begin;
        if (config.measurement == Measurement::Entropy) {
            for (auto a = begin; a < end;) {
                const auto next = std::min(end, ((a >> 8) + 1) * 256);
                for (unsigned lane = 0; lane < lanes; ++lane) {
                    auto& value = row.values[lane * config.columns + x];
                    value = static_cast<float>(value + entropies[lane * 256 + (a >> 8)] * (next - a) / count);
                }
                a = next;
            }
            continue;
        }
        unsigned access = 0;
        uint32_t byteSum = 0;
        std::array<uint32_t, 8> bitSums{};
        for (auto a = begin; a < end; ++a) {
            const auto data = xorMode ? record.ram[a] ^ previous->ram[a] : record.ram[a];
            if (config.measurement == Measurement::Activity) {
                const unsigned mask = 1u << (a & 7);
                const auto index = a >> 3;
                access |= (record.access[index] & mask ? 1u : 0u) |
                    (record.access[8192 + index] & mask ? 2u : 0u) |
                    (record.access[16384 + index] & mask ? 4u : 0u);
            }
            if (config.bits) {
                for (unsigned lane = 0; lane < 8; ++lane) bitSums[lane] += (data >> (7 - lane)) & 1;
            } else byteSum += data;
        }
        for (unsigned lane = 0; lane < lanes; ++lane) {
            const auto index = lane * config.columns + x;
            const auto sum = config.bits ? bitSums[lane] : byteSum;
            const auto mean = static_cast<float>(sum / count);
            if (config.measurement == Measurement::Activity) {
                row.values[index] = static_cast<float>(access);
                if (config.underlay) row.background[index] = mean;
            } else {
                row.values[index] = mean;
                row.anyChange[index] = sum != 0;
            }
        }
    }
    return row;
}
const ReducedRow& Metrics::cached(const HistoryRecord& record, const HistoryRecord* previous, const ViewConfig& config) const {
    const RowKey key{record.id, previous ? previous->id : 0, config.start, config.span, config.columns,
        config.measurement, config.bits, config.changesOnly, config.underlay};
    if (const auto found = rowIndex_.find(key); found != rowIndex_.end()) {
        rows_.splice(rows_.begin(), rows_, found->second);
        return found->second->second;
    }
    auto row = reduce(record, previous, config);
    const auto bytes = [](const ReducedRow& r) { return (r.values.size() + r.background.size()) * sizeof(float) + r.anyChange.size(); };
    const auto size = bytes(row);
    while (cacheBytes_ + size > 16 * 1024 * 1024 && !rows_.empty()) {
        cacheBytes_ -= bytes(rows_.back().second); rowIndex_.erase(rows_.back().first); rows_.pop_back();
    }
    rows_.emplace_front(key, std::move(row));
    try { rowIndex_.emplace(key, rows_.begin()); }
    catch (...) { rows_.pop_front(); throw; }
    cacheBytes_ += size;
    return rows_.front().second;
}
ReducedRow Metrics::band(const History& history, const ViewConfig& config, double begin, double end) const {
    bucketRange(config.start, config.span, config.columns, 0);
    ReducedRow result;
    const auto* selected = history.selected();
    if (!selected || !std::isfinite(begin) || !std::isfinite(end) || begin >= end) return result;
    const auto& records = history.records();
    auto first = std::upper_bound(records.begin(), records.end(), begin,
        [](double f, const auto& record) { return f < static_cast<double>(record->nativeFrame); });
    const bool xorMode = config.measurement == Measurement::Data && config.changesOnly;
    auto masks = xorMode ? std::make_unique<HistoryRecord>() : nullptr;
    const HistoryRecord* last = nullptr;
    for (auto i = first; i != records.end() && (*i)->id <= selected->id; ++i) {
        const auto& record = **i;
        if (record.intervalBegin >= end) break;
        if (!record.continuous) continue;
        if (xorMode) {
            const auto* previous = history.previous(record); if (!previous) continue;
            for (unsigned a = config.start; a < config.start + config.span; ++a)
                masks->ram[a] |= record.ram[a] ^ previous->ram[a];
            last = &record; continue;
        }
        if (config.measurement != Measurement::Activity) { last = &record; continue; }
        const auto& row = cached(record, history.previous(record), config);
        if (!row.valid) continue;
        if (result.valid) {
            for (std::size_t x = 0; x < row.values.size(); ++x)
                result.values[x] = static_cast<float>(static_cast<unsigned>(row.values[x]) | static_cast<unsigned>(result.values[x]));
            result.background = row.background; result.recordId = row.recordId;
        } else result = row;
    }
    if (last && xorMode) {
        auto plain = config; plain.changesOnly = false;
        masks->id = last->id; result = reduce(*masks, nullptr, plain);
    } else if (last) result = cached(*last, history.previous(*last), config);
    return result;
}
}
