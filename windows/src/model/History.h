#pragma once
#include "Capture.h"
#include <deque>
#include <map>
#include <memory>
#include <unordered_map>
#include <algorithm>
namespace visual_spc {
struct HistoryRecord : Capture {
    uint64_t id = 0, previousId = 0;
    bool continuous = false;
};
class History {
public:
    using Records = std::deque<std::unique_ptr<HistoryRecord>>;
private:
    std::map<uint32_t, Records> generations_;
    std::unordered_map<uint64_t, HistoryRecord*> ids_;
    uint64_t nextId_ = 1, selectedId_ = 0;
    uint32_t activeGeneration_ = 0;
    double presentedFrame_ = 0;
    std::size_t maxRecords_;
    void eraseFront(Records& records);
public:
    explicit History(std::size_t budget = 512ull * 1024 * 1024)
        : maxRecords_(std::max<std::size_t>(2, budget / sizeof(HistoryRecord))) {}
    bool accept(const Capture& capture);
    bool present(uint32_t generation, double frame);
    const HistoryRecord* selected() const noexcept;
    const HistoryRecord* get(uint64_t id) const noexcept;
    const HistoryRecord* previous(const HistoryRecord& record) const noexcept;
    const Records& records() const noexcept;
    double presentedFrame() const noexcept { return presentedFrame_; }
    std::size_t payloadBytes() const noexcept { return ids_.size() * sizeof(HistoryRecord); }
    double retainedSeconds() const noexcept;
};
}
