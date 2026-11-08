#pragma once
#include "History.h"
#include <utility>
#include <vector>
#include <list>
#include <tuple>
namespace visual_spc {
enum class Measurement { Activity, Data, Entropy };
struct ViewConfig {
    Measurement measurement = Measurement::Activity;
    bool bits = false, changesOnly = false, underlay = false;
    uint32_t start = 0, span = 65536, columns = 256;
};
struct ReducedRow {
    std::vector<float> values, background;
    std::vector<uint8_t> anyChange;
    uint64_t recordId = 0;
    bool valid = false;
};
std::pair<uint32_t, uint32_t> bucketRange(uint32_t start, uint32_t span, uint32_t columns, uint32_t column);
class Metrics {
    std::array<double, 257> countLog_{};
    std::array<float, 257> binary_{};
    using RowKey = std::tuple<uint64_t, uint64_t, uint32_t, uint32_t, uint32_t, Measurement, bool, bool, bool>;
    mutable std::list<std::pair<RowKey, ReducedRow>> rows_;
    mutable std::map<RowKey, decltype(rows_)::iterator> rowIndex_;
    mutable std::size_t cacheBytes_ = 0;
    const ReducedRow& cached(const HistoryRecord&, const HistoryRecord*, const ViewConfig&) const;
public:
    Metrics();
    std::vector<float> entropy(const std::array<uint8_t, 65536>& ram, bool bits) const;
    ReducedRow reduce(const HistoryRecord&, const HistoryRecord*, const ViewConfig&) const;
    ReducedRow band(const History&, const ViewConfig&, double begin, double end) const;
    void clearCache() const noexcept { rowIndex_.clear(); rows_.clear(); cacheBytes_ = 0; }
};
}
