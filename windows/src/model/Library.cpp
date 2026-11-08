#include "Library.h"
#include "platform/Files.h"
#include <Windows.h>
#include <algorithm>
#include <cwctype>
#include <memory>
namespace visual_spc {
Library::Library() {
    loader_ = std::thread([this] { loadLoop(); });
    try { scanner_ = std::thread([this] { scanLoop(); }); }
    catch (...) { { std::lock_guard lock(mutex_); stopping_ = true; } changed_.notify_all(); loader_.join(); throw; }
}
Library::~Library() {
    { std::lock_guard lock(mutex_); stopping_ = true; }
    changed_.notify_all(); loader_.join(); scanner_.join();
}
uint64_t Library::scan(const std::filesystem::path& root) {
    std::lock_guard lock(mutex_);
    const auto revision = ++scanRevision_;
    scanRoot_ = root; scanRequested_ = true; batches_.clear(); changed_.notify_all(); return revision;
}
void Library::cancelScan() {
    std::lock_guard lock(mutex_); ++scanRevision_; scanRequested_ = false;
    batches_.clear(); changed_.notify_all();
}
uint64_t Library::load(const std::filesystem::path& path) {
    std::lock_guard lock(mutex_);
    std::erase_if(jobs_, [](const Job& job) { return job.kind == Kind::Load; });
    if (jobs_.size() >= 128) return 0;
    const auto id = ++loadRevision_; jobs_.push_back({Kind::Load, id, path}); changed_.notify_all(); return id;
}
bool Library::retire(spc_native_instance* instance) {
    if (!instance) return true;
    std::lock_guard lock(mutex_); if (jobs_.size() >= 128) return false;
    jobs_.push_back({Kind::Retire, 0, {}, instance}); changed_.notify_all(); return true;
}
bool Library::save(const std::filesystem::path& path, std::string text) {
    std::lock_guard lock(mutex_);
    std::erase_if(jobs_, [&](const Job& job) { return job.kind == Kind::Save && job.path == path; });
    if (jobs_.size() >= 128) return false;
    jobs_.push_back({Kind::Save, 0, path, nullptr, std::move(text)}); changed_.notify_all(); return true;
}
bool Library::popScan(ScanBatch& result) {
    std::lock_guard lock(mutex_); if (batches_.empty()) return false;
    result = std::move(batches_.front()); batches_.pop_front(); changed_.notify_all(); return true;
}
bool Library::popLoad(LoadResult& result) {
    std::lock_guard lock(mutex_); if (results_.empty()) return false;
    result = std::move(results_.front()); results_.pop_front(); changed_.notify_all(); return true;
}
bool Library::popWarning(std::string& result) {
    std::lock_guard lock(mutex_); if (warnings_.empty()) return false;
    result = std::move(warnings_.front()); warnings_.pop_front(); return true;
}
void Library::loadLoop() {
    while (true) {
        Job job;
        {
            std::unique_lock lock(mutex_); changed_.wait(lock, [&] { return stopping_ || !jobs_.empty(); });
            if (stopping_) {
                auto pendingJobs = std::move(jobs_);
                auto pendingResults = std::move(results_);
                lock.unlock();
                for (auto& pending : pendingJobs) {
                    if (pending.kind == Kind::Retire) spc_native_destroy(pending.instance);
                    else if (pending.kind == Kind::Save) {
                        try { saveAtomic(pending.path, pending.text); } catch (...) {}
                    }
                }
                for (auto& result : pendingResults) spc_native_destroy(result.instance);
                return;
            }
            job = std::move(jobs_.front()); jobs_.pop_front();
        }
        if (job.kind == Kind::Retire) { spc_native_destroy(job.instance); continue; }
        if (job.kind == Kind::Save) {
            try { saveAtomic(job.path, job.text); }
            catch (const std::exception& failure) {
                std::lock_guard lock(mutex_); if (warnings_.size() < 8) warnings_.push_back(failure.what());
            }
            continue;
        }
        LoadResult result; result.id = job.id; result.path = job.path;
        std::unique_ptr<spc_native_instance, decltype(&spc_native_destroy)> prepared(nullptr, spc_native_destroy);
        try {
            const auto text = readText(job.path, 64 * 1024 * 1024);
            const auto* image = reinterpret_cast<const uint8_t*>(text.data());
            prepared.reset(spc_native_create());
            if (!prepared || spc_native_load(prepared.get(), image, static_cast<uint32_t>(text.size()), 1))
                throw std::runtime_error("Could not load the SPC file");
            spc_metadata_parse(image, text.size(), &result.metadata);
        } catch (const std::exception& failure) { result.error = failure.what(); }
        if (job.id != loadRevision_.load()) continue;
        std::unique_lock lock(mutex_);
        changed_.wait(lock, [&] { return stopping_ || results_.size() < 4 || job.id != loadRevision_.load(); });
        if (stopping_ || job.id != loadRevision_.load()) continue;
        if (result.error.empty()) result.instance = prepared.release();
        results_.push_back(std::move(result));
    }
}
void Library::scanLoop() {
    while (true) {
        std::filesystem::path root; uint64_t revision = 0;
        {
            std::unique_lock lock(mutex_); changed_.wait(lock, [&] { return stopping_ || scanRequested_; });
            if (stopping_) return;
            root = scanRoot_; revision = scanRevision_; scanRequested_ = false;
        }
        ScanBatch batch; batch.revision = revision;
        auto publish = [&]() {
            std::unique_lock lock(mutex_);
            changed_.wait(lock, [&] { return stopping_ || revision != scanRevision_ || batches_.size() < 8; });
            if (stopping_ || revision != scanRevision_) return false;
            batches_.push_back(std::move(batch)); batch = {}; batch.revision = revision; return true;
        };
        try {
            std::error_code error;
            std::filesystem::recursive_directory_iterator iterator(root,
                std::filesystem::directory_options::skip_permission_denied, error), end;
            if (error) throw std::runtime_error("Could not scan the folder");
            for (; iterator != end; iterator.increment(error)) {
                { std::lock_guard lock(mutex_); if (stopping_ || revision != scanRevision_) break; }
                if (error) { error.clear(); continue; }
                const auto& entry = *iterator;
                const DWORD attributes = GetFileAttributesW(entry.path().c_str());
                if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
                    if (attributes & FILE_ATTRIBUTE_DIRECTORY) iterator.disable_recursion_pending();
                    continue;
                }
                if (!entry.is_regular_file(error)) continue;
                auto extension = entry.path().extension().wstring();
                std::transform(extension.begin(), extension.end(), extension.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
                if (extension == L".spc") batch.files.push_back(entry.path());
                if (batch.files.size() == 256 && !publish()) break;
            }
        } catch (const std::exception& failure) { batch.error = failure.what(); }
        batch.complete = true; publish();
    }
}
}
