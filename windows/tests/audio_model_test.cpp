#include "audio/Resampler.h"
#include "audio/PlaybackTimeline.h"
#include "concurrency/SpscRing.h"
#include "test_check.h"
#include <array>
#include <cmath>
#include <fstream>
#include <vector>
#include <memory>

int main() {
    using namespace visual_spc;
    SpscRing<int, 4> queue;
    CHECK(!queue.consumer_slot());
    for (int i = 0; i < 3; ++i) { *queue.producer_slot() = i; queue.publish(); }
    CHECK(!queue.producer_slot());
    for (int i = 0; i < 3; ++i) { CHECK(*queue.consumer_slot() == i); queue.consume(); }
    CHECK(!queue.consumer_slot());

    CaptureCadence cadence(240, 1);
    cadence.reset(0);
    for (uint64_t i = 1; i <= 2400; ++i) {
        CHECK(cadence.next() == i * 32000 / 240);
        cadence.advance();
    }
    CaptureCadence fractional(240000, 1001);
    fractional.reset(0);
    for (uint64_t i = 1; i <= 240000; ++i) {
        CHECK(fractional.next() == i * 32000 * 1001 / 240000);
        fractional.advance();
    }
    PlaybackTimeline timeline;
    CHECK(timeline.append({1, 0, 480, 7, 0.0, 32000.0 / 48000}));
    CHECK(timeline.append({1, 480, 960, 7, 320.0, 0.0}));
    CHECK(timeline.append({1, 960, 1440, 8, 0.0, 32000.0 / 48000}));
    auto position = timeline.at(1, 240);
    CHECK(position && position->generation == 7 && position->sourceFrame == 160);
    position = timeline.at(1, 720);
    CHECK(position && position->sourceFrame == 320);
    position = timeline.at(1, 960);
    CHECK(position && position->generation == 8 && position->sourceFrame == 0);
    CHECK(!timeline.at(2, 100));
    CHECK(!timeline.at(1, 1441));

    for (const unsigned rate : {32000u, 44100u, 48000u, 96000u}) {
        auto resamplerStorage = std::make_unique<Resampler>(rate);
        auto& resampler = *resamplerStorage;
        std::array<int16_t, 2048> input{};
        input.fill(16384);
        std::array<float, 960> left{}, right{};
        for (int block = 0; block < 100; ++block) {
            const auto needed = resampler.neededInputFrames(left.size());
            CHECK(needed * 2 <= input.size());
            CHECK(resampler.push(input.data(), needed));
            CHECK(resampler.read(left.data(), right.data(), left.size()) == left.size());
            // Zero-extension startup can span 24 output frames at 96 kHz.
            for (size_t i = 32; i < left.size(); ++i) {
                CHECK(std::isfinite(left[i]) && std::abs(left[i] - 0.5f) < 0.00001f);
                CHECK(left[i] == right[i]);
            }
        }
        CHECK(std::abs(resampler.sourcePosition() - 96000.0 * 32000 / rate) < 0.00001);
        resampler.reset();
        CHECK(resampler.sourcePosition() == 0);
    }
    // Output must be independent of device callback partitioning.
    auto aStorage = std::make_unique<Resampler>(48000);
    auto bStorage = std::make_unique<Resampler>(48000);
    auto& a = *aStorage; auto& b = *bStorage;
    std::vector<int16_t> signal(4000);
    for (size_t i = 0; i < signal.size(); ++i) signal[i] = static_cast<int16_t>(i * 137);
    CHECK(a.push(signal.data(), 2000) && b.push(signal.data(), 2000));
    std::array<float, 1000> al{}, ar{}, bl{}, br{};
    CHECK(a.read(al.data(), ar.data(), 1000) == 1000);
    CHECK(b.read(bl.data(), br.data(), 133) == 133);
    CHECK(b.read(bl.data() + 133, br.data() + 133, 867) == 867);
    CHECK(al == bl && ar == br);
    // Undrained queue wrap preserves FIFO; no overwrite of unread items.
    for (int i = 0; i < 10000; ++i) {
        CHECK(queue.producer_slot()); *queue.producer_slot() = i; queue.publish();
        CHECK(*queue.consumer_slot() == i); queue.consume();
    }
    // Oversupply fails atomically, without corrupting the FIR ring/cursor.
    CHECK(!a.push(signal.data(), 32769));
    CHECK(a.sourcePosition() == b.sourcePosition());
    for (const unsigned rate : {44100u, 48000u, 96000u}) {
        auto streamStorage = std::make_unique<Resampler>(rate);
        auto& stream = *streamStorage;
        std::array<int16_t, 512> input{};
        std::array<float, 133> left{}, right{};
        for (unsigned block = 0; block < 1000; ++block) {
            const auto needed = stream.neededInputFrames(133);
            CHECK(needed * 2 <= input.size());
            CHECK(stream.push(input.data(), needed));
            CHECK(stream.read(left.data(), right.data(), 133) == 133);
        }
    }
    // Committed expected PCM comes directly from the browser implementation.
    std::ifstream fixture(SPC_RESAMPLER_FIXTURE, std::ios::binary);
    CHECK(fixture.good());
    for (unsigned caseIndex = 0; caseIndex < 4; ++caseIndex) {
        uint32_t rate = 0, count = 0;
        fixture.read(reinterpret_cast<char*>(&rate), 4);
        fixture.read(reinterpret_cast<char*>(&count), 4);
        CHECK(count == 256);
        std::vector<int16_t> input(4096);
        for (size_t i = 0; i < input.size(); ++i) input[i] = static_cast<int16_t>((i * 137) % 65536 - 32768);
        auto nativeStorage = std::make_unique<Resampler>(rate);
        auto& native = *nativeStorage;
        CHECK(native.push(input.data(), 2048));
        std::array<float, 256> left{}, right{};
        CHECK(native.read(left.data(), right.data(), count) == count);
        for (size_t i = 0; i < count; ++i) {
            float expectedLeft = 0, expectedRight = 0;
            fixture.read(reinterpret_cast<char*>(&expectedLeft), 4);
            fixture.read(reinterpret_cast<char*>(&expectedRight), 4);
            CHECK(fixture.good());
            CHECK(std::abs(left[i] - expectedLeft) <= 0.000001f);
            CHECK(std::abs(right[i] - expectedRight) <= 0.000001f);
        }
    }
}
