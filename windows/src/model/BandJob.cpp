#include "BandJob.h"
#include <algorithm>
#include <cmath>
namespace visual_spc {
BandJob::BandJob(const History& history, const ViewConfig& config, double begin, double end, uint64_t endpoint)
    : config_(config), begin_(begin), end_(end) {
    bucketRange(config.start, config.span, config.columns, 0);
    const auto* selected = endpoint ? history.get(endpoint) : history.selected();
    if (selected && history.selected() && selected->generation != history.selected()->generation) { done_ = true; return; }
    if (!selected || !std::isfinite(begin) || !std::isfinite(end) || begin >= end) { done_ = true; return; }
    endpoint_ = selected->id;
    const auto& records = history.records();
    auto first = std::upper_bound(records.begin(), records.end(), begin,
        [](double frame, const auto& record) { return frame < static_cast<double>(record->nativeFrame); });
    for (auto i = first; i != records.end() && (*i)->id <= endpoint_; ++i) {
        const auto& record = **i;
        if (record.intervalBegin >= end) break;
        if (!record.continuous || (config.changesOnly && !history.previous(record))) continue;
        records_.push_back(record.id);
    }
    if (records_.empty()) { done_ = true; return; }
    if (config.measurement == Measurement::Activity || config.changesOnly) merged_ = std::make_unique<HistoryRecord>();
    offset_ = config.changesOnly ? config.start : 0;
}
bool BandJob::step(const History& history, const Metrics& metrics, std::chrono::steady_clock::time_point deadline) {
    if (done_) return true;
    if (std::chrono::steady_clock::now() >= deadline) return false;
    if (merged_) {
        const bool changes = config_.measurement == Measurement::Data && config_.changesOnly;
        const auto count = changes ? config_.start + config_.span : 24576u;
        while (record_ < records_.size()) {
            const auto* current = history.get(records_[record_]);
            const auto* previous = current && changes ? history.previous(*current) : nullptr;
            if (!current || (changes && !previous)) { result_ = {}; done_ = true; return true; }
            const auto end = std::min<std::size_t>(count, offset_ + 4096);
            if (changes) for (auto a = offset_; a < end; ++a) merged_->ram[a] |= current->ram[a] ^ previous->ram[a];
            else for (auto a = offset_; a < end; ++a) merged_->access[a] |= current->access[a];
            offset_ = end;
            if (offset_ == count) { ++record_; offset_ = changes ? config_.start : 0; }
            if (std::chrono::steady_clock::now() >= deadline) return false;
        }
    }
    const auto* ending = history.get(records_.back());
    if (!ending) { result_ = {}; done_ = true; return true; }
    if (merged_) {
        auto plain = config_; plain.changesOnly = false;
        if (plain.measurement == Measurement::Activity) merged_->ram = ending->ram;
        merged_->id = ending->id;
        result_ = metrics.reduce(*merged_, nullptr, plain);
    } else result_ = metrics.reduce(*ending, history.previous(*ending), config_);
    done_ = true; return true;
}
bool BandJob::needsRefresh(const History& history) const {
    const auto* selected = history.selected();
    if (!selected || selected->id <= endpoint_) return false;
    const auto& records = history.records();
    auto first = std::upper_bound(records.begin(), records.end(), endpoint_,
        [](uint64_t id, const auto& record) { return id < record->id; });
    for (auto i = first; i != records.end() && (*i)->id <= selected->id; ++i) {
        if ((*i)->intervalBegin >= end_) break;
        if ((*i)->continuous && (*i)->nativeFrame > begin_) return true;
    }
    return false;
}
}
