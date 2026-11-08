#pragma once
#include "desktop_api.h"
#include "backend/spc_metadata.h"
#include <atomic>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <mutex>
#include <thread>
#include <vector>
namespace visual_spc {
struct ScanBatch {
    uint64_t revision = 0;
    std::vector<std::filesystem::path> files;
    bool complete = false;
    std::string error;
};
struct LoadResult {
    uint64_t id = 0;
    std::filesystem::path path;
    spc_native_instance* instance = nullptr;
    spc_metadata_t metadata{};
    std::string error;
};
class Library {
    enum class Kind { Load, Retire, Save };
    struct Job {
        Kind kind;
        uint64_t id = 0;
        std::filesystem::path path;
        spc_native_instance* instance = nullptr;
        std::string text;
    };
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<Job> jobs_;
    std::deque<LoadResult> results_;
    std::deque<ScanBatch> batches_;
    std::deque<std::string> warnings_;
    std::filesystem::path scanRoot_;
    std::atomic<uint64_t> scanRevision_{0}, loadRevision_{0};
    bool scanRequested_ = false, stopping_ = false;
    std::thread loader_, scanner_;
    void loadLoop();
    void scanLoop();
public:
    Library();
    ~Library();
    uint64_t scan(const std::filesystem::path&);
    void cancelScan();
    uint64_t load(const std::filesystem::path&);
    bool retire(spc_native_instance*);
    bool save(const std::filesystem::path&, std::string text);
    bool popScan(ScanBatch&);
    bool popLoad(LoadResult&);
    bool popWarning(std::string&);
};
}
