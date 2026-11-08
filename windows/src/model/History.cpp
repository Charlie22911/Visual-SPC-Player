#include "History.h"
#include <algorithm>
#include <cmath>
namespace visual_spc {
void History::eraseFront(Records& records) {
    ids_.erase(records.front()->id);
    records.pop_front();
    if (!records.empty()) { records.front()->continuous = false; records.front()->previousId = 0; }
}
bool History::accept(const Capture& capture) {
    if (!generations_.contains(capture.generation) && generations_.size() >= 4) return false;
    auto& records = generations_[capture.generation];
    if (!records.empty() && (capture.sequence <= records.back()->sequence ||
        capture.nativeFrame <= records.back()->nativeFrame)) return false;
    if (ids_.size() >= maxRecords_) {
        bool evicted = false;
        for (auto& [generation, entries] : generations_) {
            (void)generation;
            if (entries.size() > 1 && entries.front()->id != selectedId_) {
                eraseFront(entries); evicted = true; break;
            }
        }
        if (!evicted && records.size() > 1 && records.back()->id != selectedId_) {
            ids_.erase(records.back()->id); records.pop_back(); evicted = true;
        }
        if (!evicted) return false;
    }
    auto record = std::make_unique<HistoryRecord>();
    static_cast<Capture&>(*record) = capture;
    record->id = nextId_++;
    if (!records.empty()) {
        const auto& last = *records.back();
        record->continuous = capture.sequence == last.sequence + 1 &&
            capture.discontinuity == last.discontinuity &&
            capture.nativeFrame - last.nativeFrame <= 8000 && capture.intervalBegin == last.nativeFrame;
        if (record->continuous) record->previousId = last.id;
    }
    const auto id = record->id;
    auto* pointer = record.get();
    records.push_back(std::move(record));
    try { ids_.emplace(id, pointer); }
    catch (...) { records.pop_back(); throw; }
    return true;
}
bool History::present(uint32_t generation, double frame) {
    if (!std::isfinite(frame) || frame < 0) return false;
    auto found = generations_.find(generation);
    if (found == generations_.end()) return false;
    auto& records = found->second;
    const auto upper = std::upper_bound(records.begin(), records.end(), frame,
        [](double f, const auto& record) { return f < static_cast<double>(record->nativeFrame); });
    if (upper == records.begin()) return false;
    const auto* chosen = std::prev(upper)->get();
    if (generation == activeGeneration_ && frame < presentedFrame_) return false;
    const bool changed = chosen->id != selectedId_;
    selectedId_ = chosen->id; activeGeneration_ = generation; presentedFrame_ = frame;
    // Pending newer generations survive; retired older generations never form
    // a baseline with the current one.
    for (auto i = generations_.begin(); i != generations_.end();) {
        if (i->first < generation) {
            for (const auto& record : i->second) ids_.erase(record->id);
            i = generations_.erase(i);
        } else ++i;
    }
    const auto cutoff = frame - 320000;
    while (records.size() > 2 && records[1]->nativeFrame <= cutoff &&
        records[1]->id != selectedId_) eraseFront(records);
    return changed;
}
const HistoryRecord* History::get(uint64_t id) const noexcept {
    const auto found = ids_.find(id); return found == ids_.end() ? nullptr : found->second;
}
const HistoryRecord* History::selected() const noexcept { return get(selectedId_); }
const HistoryRecord* History::previous(const HistoryRecord& r) const noexcept {
    return r.continuous ? get(r.previousId) : nullptr;
}
const History::Records& History::records() const noexcept {
    static const Records empty;
    const auto found = generations_.find(activeGeneration_);
    return found == generations_.end() ? empty : found->second;
}
double History::retainedSeconds() const noexcept {
    const auto* end = selected(); const auto& entries = records();
    return !end || entries.empty() ? 0 : (end->nativeFrame - entries.front()->nativeFrame) / 32000.0;
}
}
