#pragma once
#include "Metrics.h"
#include <chrono>
namespace visual_spc {
// Resumable temporal aggregation. Holds IDs and owned scratch, never views into
// recyclable history. Cancellation is destruction of this object.
class BandJob {
    ViewConfig config_;
    double begin_, end_;
    uint64_t endpoint_ = 0;
    std::vector<uint64_t> records_;
    std::size_t record_ = 0, offset_ = 0;
    std::unique_ptr<HistoryRecord> merged_;
    ReducedRow result_;
    bool done_ = false;
public:
    BandJob(const History&, const ViewConfig&, double begin, double end, uint64_t endpoint = 0);
    bool step(const History&, const Metrics&, std::chrono::steady_clock::time_point deadline);
    const ReducedRow& result() const noexcept { return result_; }
    bool needsRefresh(const History&) const;
    uint64_t endpoint() const noexcept { return endpoint_; }
    uint64_t firstRecord() const noexcept { return records_.empty() ? 0 : records_.front(); }
};
}
