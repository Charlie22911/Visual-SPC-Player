#include "SpectrumWorker.h"
#include "model/Spectrogram.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <limits>
#include <mutex>
#include <thread>

namespace visual_spc {
struct SpectrumWorker::Impl {
    struct Configuration {
        unsigned fftSize = Spectrogram::FftSize, hopSize = Spectrogram::HopSize;
        uint64_t epoch = 1;
        bool enabled = true;
        uint64_t activation = 1;
    } requested;
    SpectrumQueue& input;
    // Approximately 2 MiB: never place the result ring on the UI stack.
    std::unique_ptr<SpectrumResultQueue> output = std::make_unique<SpectrumResultQueue>();
    std::mutex commandMutex;
    std::condition_variable commandChanged;
    bool stopping = false;
    uint64_t activeEpoch = 1, rowSequence = 0;
    uint32_t generation = 0;
    std::atomic<uint64_t> analysed{0}, dropped{0}, consumed{0};
    std::atomic<uint64_t> pcmHigh{0},resultHigh{0},newest{0};
    std::atomic<uint32_t> newestGen{0};
    std::atomic<bool> runningAnalysis{true};
    std::atomic<uint64_t> applied{1};
    Spectrogram analyser;
    std::thread thread;

    explicit Impl(SpectrumQueue& queue,bool enabled) : input(queue), analyser(&emit, this) {
        requested.enabled=enabled; runningAnalysis=enabled;
        input.setCaptureEnabled(enabled);
        thread = std::thread(&Impl::run, this);
    }
    static void emit(void* context, const SpectrumFrameView& row) noexcept {
        auto& self = *static_cast<Impl*>(context);
        const auto sequence = ++self.rowSequence;
        if (auto* result = self.output->producer_slot()) {
            result->stamp = {self.activeEpoch, sequence, row.nativeFrame, row.segment,
                row.generation, static_cast<uint32_t>(row.power.size())};
            std::copy(row.power.begin(), row.power.end(), result->power.begin());
            std::copy(row.difference.begin(), row.difference.end(), result->difference.begin());
            self.output->publish();
            self.resultHigh.store(std::max(self.resultHigh.load(std::memory_order_relaxed),static_cast<uint64_t>(self.output->approximate_size())),std::memory_order_relaxed);
        } else self.dropped.fetch_add(1, std::memory_order_relaxed);
        self.newest.store(row.nativeFrame,std::memory_order_relaxed);
        self.newestGen.store(row.generation,std::memory_order_release);
        self.analysed.store(sequence, std::memory_order_release);
    }
    void run() {
        uint64_t appliedActivation=1;
        for (;;) {
            // Observe the packet before sampling commands. A configuration
            // published before this packet must apply to the whole packet.
            const auto* packet = input.consumer_slot();
            Configuration next;
            {
                std::lock_guard lock(commandMutex);
                if (stopping) return;
                next = requested;
            }
            // Settings and overlap change only between complete PCM packets.
            if (next.epoch != activeEpoch) {
                analyser.configure(next.fftSize, next.hopSize);
                // A -> B -> A may coalesce to the original FFT/hop. Its new
                // epoch still starts a fresh overlap window.
                analyser.reset(generation);
                activeEpoch = next.epoch;
            }
            if(next.activation!=appliedActivation) {
                // A disabled producer can still finish one in-flight packet.
                // Drop the bounded pre-resume backlog instead of analysing it.
                for(unsigned i=0;i<255 && input.consumer_slot();++i) {
                    input.consume(); consumed.fetch_add(1,std::memory_order_release);
                }
                packet=nullptr;
                appliedActivation=next.activation;
            }
            runningAnalysis.store(next.enabled,std::memory_order_release);
            applied.store(activeEpoch,std::memory_order_release);
            if(!next.enabled) {
                for(unsigned i=0;i<255 && input.consumer_slot();++i) {
                    input.consume(); consumed.fetch_add(1,std::memory_order_release);
                }
                std::unique_lock lock(commandMutex);
                commandChanged.wait(lock,[&] { return stopping || requested.epoch!=activeEpoch; });
                continue;
            }
            if (packet) {
                pcmHigh.store(std::max(pcmHigh.load(std::memory_order_relaxed),static_cast<uint64_t>(input.approximate_size())),std::memory_order_relaxed);
                if (analyser.ingest(*packet)) generation = packet->generation;
                input.consume();
                consumed.fetch_add(1, std::memory_order_release);
                continue;
            }
            // The producer needs no event, allocation, lock or notification.
            // Configuration and stop wake immediately; PCM has a 1 ms poll.
            std::unique_lock lock(commandMutex);
            commandChanged.wait_for(lock, std::chrono::milliseconds(1), [&] {
                return stopping || requested.epoch != activeEpoch;
            });
        }
    }
    void stop() noexcept {
        input.setCaptureEnabled(false);
        {
            std::lock_guard lock(commandMutex);
            stopping = true;
        }
        commandChanged.notify_all();
        if (thread.joinable()) thread.join();
    }
    ~Impl() { stop(); }
};

SpectrumWorker::SpectrumWorker(SpectrumQueue& input,bool enabled) : impl_(std::make_unique<Impl>(input,enabled)) {}
SpectrumWorker::~SpectrumWorker() = default;
uint64_t SpectrumWorker::configure(unsigned fftSize, unsigned hopSize) {
    if ((fftSize != 1024 && fftSize != 2048 && fftSize != 4096) ||
        (hopSize != 64 && hopSize != 128 && hopSize != 256 && hopSize != 512) ||
        hopSize > fftSize) return 0;
    uint64_t epoch;
    {
        std::lock_guard lock(impl_->commandMutex);
        if (impl_->stopping) return 0;
        auto& requested = impl_->requested;
        if (requested.fftSize == fftSize && requested.hopSize == hopSize) return requested.epoch;
        if (requested.epoch == std::numeric_limits<uint64_t>::max()) return 0;
        requested = {fftSize, hopSize, requested.epoch + 1,requested.enabled,requested.activation};
        epoch = requested.epoch;
    }
    impl_->commandChanged.notify_one();
    return epoch;
}
SpectrumResultQueue& SpectrumWorker::results() noexcept { return *impl_->output; }
uint64_t SpectrumWorker::setActive(bool enabled) {
    uint64_t epoch;
    {
        std::lock_guard lock(impl_->commandMutex);
        if(impl_->stopping) return 0;
        auto& requested=impl_->requested;
        if(requested.enabled==enabled) return requested.epoch;
        if(requested.epoch==std::numeric_limits<uint64_t>::max()) return 0;
        requested.enabled=enabled; ++requested.activation; epoch=++requested.epoch;
        impl_->input.setCaptureEnabled(enabled);
    }
    impl_->commandChanged.notify_one(); return epoch;
}
bool SpectrumWorker::active() const noexcept { return impl_->runningAnalysis.load(std::memory_order_acquire); }
uint64_t SpectrumWorker::appliedEpoch() const noexcept { return impl_->applied.load(std::memory_order_acquire); }
void SpectrumWorker::stop() noexcept { impl_->stop(); }
uint64_t SpectrumWorker::analysedRows() const noexcept {
    return impl_->analysed.load(std::memory_order_acquire);
}
uint64_t SpectrumWorker::droppedResults() const noexcept {
    return impl_->dropped.load(std::memory_order_relaxed);
}
uint64_t SpectrumWorker::consumedPackets() const noexcept {
    return impl_->consumed.load(std::memory_order_acquire);
}
uint64_t SpectrumWorker::pcmHighWater() const noexcept { return impl_->pcmHigh.load(std::memory_order_relaxed); }
uint64_t SpectrumWorker::resultHighWater() const noexcept { return impl_->resultHigh.load(std::memory_order_relaxed); }
uint64_t SpectrumWorker::newestFrame() const noexcept { return impl_->newest.load(std::memory_order_relaxed); }
uint32_t SpectrumWorker::newestGeneration() const noexcept { return impl_->newestGen.load(std::memory_order_acquire); }
}
