#include "audio/SpectrumWorker.h"
#include "model/Spectrogram.h"
#include "test_check.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <memory>
#include <thread>
#include <vector>

using namespace visual_spc;
namespace {
using Clock = std::chrono::steady_clock;
constexpr double pi = 3.14159265358979323846;
template<class Predicate> bool eventually(Predicate predicate) {
    const auto deadline = Clock::now() + std::chrono::seconds(5);
    do {
        if (predicate()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    } while (Clock::now() < deadline);
    return predicate();
}
SpectrumPacket packet(uint64_t frame, uint32_t generation = 1, unsigned fft = 2048,
    uint32_t discontinuity = 0, bool opposite = false) {
    SpectrumPacket value{};
    value.generation = generation; value.discontinuity = discontinuity;
    value.nativeFrame = frame; value.frameCount = 512;
    for (unsigned i = 0; i < value.frameCount; ++i) {
        const auto sample = static_cast<int16_t>(std::lround(16384 *
            std::sin(2 * pi * 64 * static_cast<double>(frame + i) / fft)));
        value.pcm[i * 2] = sample;
        value.pcm[i * 2 + 1] = opposite ? static_cast<int16_t>(-sample) : sample;
    }
    return value;
}
bool enqueue(SpectrumQueue& queue, const SpectrumPacket& value) {
    if (!eventually([&] { return queue.producer_slot() != nullptr; })) return false;
    *queue.producer_slot() = value; queue.publish();
    return true;
}
bool feed(SpectrumQueue& queue, uint64_t first, uint64_t end,
    uint32_t generation = 1, unsigned fft = 2048, uint32_t discontinuity = 0,
    bool opposite = false) {
    for (auto frame = first; frame < end; frame += 512)
        if (!enqueue(queue, packet(frame, generation, fft, discontinuity, opposite))) return false;
    return true;
}
std::vector<SpectrumResult> drain(SpectrumWorker& worker) {
    std::vector<SpectrumResult> output;
    while (const auto* row = worker.results().consumer_slot()) {
        output.push_back(*row); worker.results().consume();
    }
    return output;
}
}

int main() {
    // Rapid commands may coalesce to enabled -> enabled. Each reactivation must
    // still discard pre-activation backlog instead of relabelling it as fresh.
    {
        auto input=std::make_unique<SpectrumQueue>();
        SpectrumWorker worker(*input);
        uint64_t frame=0;
        for(unsigned round=0;round<32;++round) {
            std::array<SpectrumPacket,4> stale{};
            for(unsigned i=0;i<4;++i) stale[i]=packet(frame+i*512);
            worker.setActive(false);
            for(const auto& p:stale) CHECK(enqueue(*input,p));
            frame+=2048;
            const auto epoch=worker.setActive(true);
            CHECK(eventually([&] { return worker.appliedEpoch()==epoch; }));
            for(const auto& row:drain(worker)) CHECK(row.stamp.analysisEpoch!=epoch);
            CHECK(feed(*input,frame,frame+2048)); frame+=2048;
            CHECK(eventually([&] { return input->approximate_size()==0; }));
            auto rows=drain(worker); CHECK(rows.size()==1);
            CHECK(rows.front().stamp.analysisEpoch==epoch && rows.front().stamp.endFrame==frame);
        }
    }
    // Inactive views do not run FFTs, including queued/in-flight PCM. Returning
    // starts a complete fresh window and does not catch up on stale history.
    {
        auto input=std::make_unique<SpectrumQueue>();
        SpectrumWorker worker(*input,false);
        CHECK(!input->captureEnabled() && !worker.active());
        CHECK(feed(*input,0,4096));
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        CHECK(worker.analysedRows()==0 && drain(worker).empty());
        const auto epoch=worker.setActive(true);
        CHECK(epoch==2 && input->captureEnabled());
        CHECK(eventually([&] { return worker.active(); }));
        CHECK(feed(*input,4096,6144));
        CHECK(eventually([&] { return worker.analysedRows()==1; }));
        auto rows=drain(worker); CHECK(rows.size()==1);
        CHECK(rows.front().stamp.analysisEpoch==epoch && rows.front().stamp.endFrame==6144);
        CHECK(worker.setActive(false)==3);
        CHECK(eventually([&] { return !worker.active(); }));
        const auto analysed=worker.analysedRows();
        CHECK(!input->captureEnabled());
        CHECK(feed(*input,6144,10240));
        CHECK(worker.configure(1024,64)==4);
        CHECK(eventually([&] { return input->approximate_size()==0; }));
        CHECK(worker.analysedRows()==analysed && drain(worker).empty());
        CHECK(worker.setActive(true)==5);
        CHECK(eventually([&] { return worker.active(); }));
        CHECK(feed(*input,10240,11264));
        CHECK(eventually([&] { return worker.analysedRows()==analysed+1; }));
        rows=drain(worker); CHECK(rows.size()==1);
        CHECK(rows.front().stamp.endFrame==11264 && rows.front().stamp.analysisEpoch==5);
    }
    // Streaming analysis must keep calibrated reusable output without retaining
    // a second history, including after changing the FFT configuration.
    {
        struct SinkState {
            uint64_t rows = 0, endFrame = 0;
            unsigned bins = 0;
            float power = 0, difference = 0;
        } captured;
        Spectrogram stream([](void* context, const SpectrumFrameView& row) noexcept {
            auto& sink = *static_cast<SinkState*>(context);
            ++sink.rows; sink.endFrame = row.nativeFrame;
            sink.bins = static_cast<unsigned>(row.power.size());
            sink.power = row.power[64]; sink.difference = row.difference[64];
        }, &captured);
        for (unsigned frame = 0; frame < 32768; frame += 512)
            CHECK(stream.ingest(packet(frame)));
        CHECK(stream.rows().empty());
        CHECK(captured.rows == 121 && captured.endFrame == 32768 && captured.bins == 1025);
        CHECK(std::abs(captured.power - 0.25f) < 0.0001f && captured.difference == 0);
        CHECK(stream.configure(1024, 64));
        CHECK(stream.ingest(packet(32768, 1, 1024, 0, true)));
        CHECK(stream.ingest(packet(33280, 1, 1024, 0, true)));
        CHECK(stream.rows().empty() && captured.rows == 122 && captured.bins == 513);
        CHECK(std::abs(captured.difference - 0.25f) < 0.0001f);
    }

    // Removing the worker's PCM analysis must fail calibration and row timing.
    {
        auto input = std::make_unique<SpectrumQueue>();
        SpectrumWorker worker(*input);
        CHECK(worker.configure(2048, 256) == 1);
        CHECK(feed(*input, 0, 2560));
        CHECK(eventually([&] { return worker.consumedPackets() == 5; }));
        const auto rows = drain(worker);
        CHECK(rows.size() == 3);
        for (unsigned i = 0; i < rows.size(); ++i) {
            CHECK(rows[i].stamp.analysisEpoch == 1 && rows[i].stamp.rowSequence == i + 1);
            CHECK(rows[i].stamp.endFrame == 2048 + i * 256 && rows[i].stamp.generation == 1);
            CHECK(rows[i].stamp.bins == 1025 && rows[i].stamp.segment != 0);
            CHECK(std::abs(rows[i].power[64] - 0.25f) < 0.0001f);
            CHECK(rows[i].difference[64] == 0);
        }
        CHECK(worker.analysedRows() == 3 && worker.droppedResults() == 0);
    }

    // Even a coalesced A -> B -> A request starts a new epoch's full window.
    {
        auto input = std::make_unique<SpectrumQueue>();
        SpectrumWorker worker(*input);
        CHECK(feed(*input, 0, 1536));
        CHECK(eventually([&] { return worker.consumedPackets() == 3; }));
        CHECK(worker.configure(1024, 64) == 2);
        CHECK(worker.configure(2048, 256) == 3);
        CHECK(feed(*input, 1536, 2048));
        CHECK(eventually([&] { return worker.consumedPackets() == 4; }));
        CHECK(drain(worker).empty());
        CHECK(feed(*input, 2048, 3584));
        CHECK(eventually([&] { return worker.consumedPackets() == 7; }));
        const auto rows = drain(worker);
        CHECK(rows.size() == 1 && rows[0].stamp.analysisEpoch == 3);
        CHECK(rows[0].stamp.endFrame == 3584 && rows[0].stamp.rowSequence == 1);
    }

    // Reusing overlap across PCM gaps/discontinuities/generations would create
    // premature rows, or let future-track data erase still-pending results.
    {
        auto input = std::make_unique<SpectrumQueue>();
        SpectrumWorker worker(*input);
        CHECK(feed(*input, 0, 2048));
        CHECK(feed(*input, 4096, 6144));
        CHECK(feed(*input, 6144, 8192, 1, 2048, 1));
        CHECK(feed(*input, 0, 2048, 7));
        CHECK(feed(*input, 0, 2048, 9, 2048, 0, true));
        CHECK(enqueue(*input, packet(2048, 7))); // Obsolete generation.
        auto malformed = packet(2048, 9); malformed.frameCount = 513;
        CHECK(enqueue(*input, malformed));
        CHECK(eventually([&] { return worker.consumedPackets() == 22; }));
        const auto rows = drain(worker);
        CHECK(rows.size() == 5);
        CHECK(rows[0].stamp.endFrame == 2048 && rows[1].stamp.endFrame == 6144);
        CHECK(rows[2].stamp.endFrame == 8192);
        CHECK(rows[3].stamp.generation == 7 && rows[4].stamp.generation == 9);
        for (unsigned i = 1; i < rows.size(); ++i)
            CHECK(rows[i].stamp.segment > rows[i - 1].stamp.segment);
        CHECK(std::abs(rows[4].difference[64] - 0.25f) < 0.0001f);
    }

    // Reconfiguration must clear overlap, preserve complete configurations, and
    // tag late results so a UI can reject obsolete epochs.
    {
        auto input = std::make_unique<SpectrumQueue>();
        SpectrumWorker worker(*input);
        CHECK(feed(*input, 0, 2048));
        CHECK(eventually([&] { return worker.consumedPackets() == 4; }));
        CHECK(worker.configure(1024, 64) == 2);
        CHECK(worker.configure(1024, 64) == 2);
        CHECK(worker.configure(512, 64) == 0);
        CHECK(worker.configure(2048, 32) == 0);
        CHECK(worker.configure(4096, 512) == 3);
        CHECK(worker.configure(1024, 128) == 4);
        CHECK(feed(*input, 2048, 3072, 1, 1024));
        CHECK(eventually([&] { return worker.consumedPackets() == 6; }));
        const auto rows = drain(worker);
        if (rows.size() != 2) {
            std::fprintf(stderr, "reconfiguration emitted %zu rows\n", rows.size());
            for (const auto& row : rows)
                std::fprintf(stderr, "epoch=%llu end=%llu bins=%u\n",
                    static_cast<unsigned long long>(row.stamp.analysisEpoch),
                    static_cast<unsigned long long>(row.stamp.endFrame), row.stamp.bins);
        }
        CHECK(rows.size() == 2);
        CHECK(rows[0].stamp.analysisEpoch == 1 && rows[0].stamp.bins == 1025);
        CHECK(rows[1].stamp.analysisEpoch == 4 && rows[1].stamp.bins == 513);
        CHECK(rows[1].stamp.endFrame == 3072 && rows[1].stamp.rowSequence == 2);
        CHECK(std::abs(rows[1].power[64] - 0.25f) < 0.0001f);
        CHECK(feed(*input, 3072, 3584, 1, 1024));
        CHECK(eventually([&] { return worker.consumedPackets() == 7; }));
        const auto more = drain(worker);
        CHECK(more.size() == 4);
        for (unsigned i = 0; i < more.size(); ++i) {
            CHECK(more[i].stamp.analysisEpoch == 4);
            CHECK(more[i].stamp.endFrame == 3200 + i * 128);
        }
    }

    // A saturated result queue must drop without blocking PCM consumption;
    // sequence numbers must expose every missing result after it is drained.
    {
        auto input = std::make_unique<SpectrumQueue>();
        SpectrumWorker worker(*input);
        CHECK(worker.configure(1024, 64) == 2);
        CHECK(feed(*input, 0, 16384, 1, 1024));
        CHECK(eventually([&] { return worker.consumedPackets() == 32; }));
        CHECK(worker.analysedRows() == 241);
        CHECK(worker.droppedResults() == 114);
        CHECK(worker.resultHighWater() == 127);
        CHECK(worker.results().approximate_size() == 127);
        CHECK(worker.pcmHighWater() > 0);
        const auto rows = drain(worker);
        CHECK(rows.size() == 127 && rows.back().stamp.rowSequence == 127);
        CHECK(feed(*input, 16384, 16896, 1, 1024));
        CHECK(eventually([&] { return worker.consumedPackets() == 33; }));
        const auto more = drain(worker);
        CHECK(more.size() == 8 && more.front().stamp.rowSequence == 242);
        CHECK(more.front().stamp.segment == rows.back().stamp.segment);
        CHECK(more.front().stamp.endFrame == 16448);
    }

    // Rapid commands racing packet consumption must never combine half of two
    // configurations. Their epoch identifies a complete FFT/hop pair.
    {
        auto input = std::make_unique<SpectrumQueue>();
        SpectrumWorker worker(*input);
        for (unsigned index = 0; index < 100; ++index) {
            const auto fft = index % 2 ? 4096u : 1024u;
            const auto hop = index % 2 ? 512u : 64u;
            CHECK(worker.configure(fft, hop) == index + 2);
            CHECK(enqueue(*input, packet(index * 512, 1, fft)));
        }
        CHECK(eventually([&] { return worker.consumedPackets() == 100; }));
        const auto rows = drain(worker);
        for (const auto& row : rows) {
            CHECK(row.stamp.analysisEpoch >= 2 && row.stamp.analysisEpoch <= 101);
            CHECK(row.stamp.bins == (row.stamp.analysisEpoch % 2 ? 2049u : 513u));
        }
        const auto latest = worker.configure(1024, 64);
        CHECK(latest == 102);
        CHECK(feed(*input, 51200, 52224, 1, 1024));
        CHECK(eventually([&] { return worker.consumedPackets() == 102; }));
        const auto last = drain(worker);
        CHECK(last.size() == 1 && last[0].stamp.analysisEpoch == latest);
    }

    // Stop must wake an idle wait and join with a live producer still owning
    // its queue; the producer does not signal or use any worker-owned handle.
    {
        auto input = std::make_unique<SpectrumQueue>();
        auto worker = std::make_unique<SpectrumWorker>(*input);
        std::atomic<bool> quit{false};
        std::thread producer([&] {
            uint64_t frame = 0;
            while (!quit.load(std::memory_order_acquire)) {
                if (auto* slot = input->producer_slot()) {
                    *slot = packet(frame); input->publish(); frame += 512;
                } else std::this_thread::yield();
            }
        });
        const bool active = eventually([&] { return worker->consumedPackets() >= 4; });
        const auto start = Clock::now();
        worker.reset();
        const auto elapsed = Clock::now() - start;
        quit.store(true, std::memory_order_release); producer.join();
        CHECK(active && elapsed < std::chrono::seconds(2));
        auto emptyInput = std::make_unique<SpectrumQueue>();
        SpectrumWorker idle(*emptyInput);
        // Give the worker an opportunity to enter its empty-queue timed wait.
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        const auto idleStart = Clock::now();
        idle.stop(); idle.stop();
        CHECK(Clock::now() - idleStart < std::chrono::seconds(2));
        CHECK(idle.configure(1024, 64) == 0);
    }
}
