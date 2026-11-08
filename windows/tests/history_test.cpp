#include "model/History.h"
#include "model/Metrics.h"
#include "model/BandJob.h"
#include "test_check.h"
#include <memory>
#include <fstream>
#include <cmath>
using namespace visual_spc;
int main() {
    History history;
    auto capture = std::make_unique<Capture>();
    capture->generation = 1;
    CHECK(history.accept(*capture));
    capture->sequence = 1; capture->nativeFrame = 133; capture->intervalBegin = 0;
    capture->ram[0] = 255; capture->access[8192] = 1;
    CHECK(history.accept(*capture));
    capture->sequence = 2; capture->nativeFrame = 266; capture->intervalBegin = 133;
    capture->ram[0] = 0; capture->access.fill(0); capture->access[0] = 1;
    CHECK(history.accept(*capture));
    CHECK(history.present(1, 133));
    Metrics metrics;
    const ViewConfig changes{Measurement::Data, false, true, false, 0, 1, 1};
    auto row = metrics.band(history, changes, 0, 300);
    CHECK(row.valid && row.values[0] == 255); // future A->B->A excluded
    CHECK(row.recordId == history.selected()->id);
    CHECK(history.present(1, 266));
    row = metrics.band(history, changes, 0, 300);
    CHECK(row.valid && row.values[0] == 255); // OR masks before reduction
    BandJob resumable(history, changes, 0, 300);
    CHECK(!resumable.step(history, metrics, std::chrono::steady_clock::now()));
    CHECK(resumable.step(history, metrics, std::chrono::steady_clock::now() + std::chrono::seconds(1)));
    CHECK(resumable.result().valid && resumable.result().values == row.values);
    ViewConfig activity{Measurement::Activity, false, false, true, 0, 1, 1};
    row = metrics.band(history, activity, 0, 300);
    CHECK(row.values[0] == 3 && row.background[0] == 0);
    capture->generation = 2; capture->sequence = 0; capture->nativeFrame = 0;
    CHECK(history.accept(*capture));
    CHECK(history.selected()->generation == 1);
    CHECK(history.present(2, 0));
    CHECK(history.selected()->generation == 2);
    CHECK(!history.previous(*history.selected()));
    std::array<uint8_t, 65536> ram{};
    auto entropy = metrics.entropy(ram, false);
    CHECK(entropy[0] == 0);
    for (unsigned i = 0; i < 256; ++i) ram[i] = static_cast<uint8_t>(i);
    entropy = metrics.entropy(ram, false);
    CHECK(entropy[0] == 8);
    entropy = metrics.entropy(ram, true);
    for (unsigned lane = 0; lane < 8; ++lane) CHECK(entropy[lane * 256] == 1);
    // Adjacent non-divisible buckets cover the complete address window.
    uint32_t end = 10;
    for (unsigned x = 0; x < 3; ++x) {
        const auto range = bucketRange(10, 7, 3, x);
        CHECK(range.first == end && range.second > range.first); end = range.second;
    }
    CHECK(end == 17);
    History bounded(3 * sizeof(HistoryRecord));
    capture->generation = 1; capture->discontinuity = 0;
    for (unsigned i = 0; i < 3; ++i) {
        capture->sequence = i; capture->nativeFrame = i * 100; capture->intervalBegin = i ? (i - 1) * 100 : 0;
        CHECK(bounded.accept(*capture));
    }
    CHECK(bounded.present(1, 100));
    const auto selectedId = bounded.selected()->id;
    for (unsigned i = 3; i < 8; ++i) {
        capture->sequence = i; capture->nativeFrame = i * 100; capture->intervalBegin = (i - 1) * 100;
        CHECK(bounded.accept(*capture));
        CHECK(bounded.payloadBytes() <= 3 * sizeof(HistoryRecord));
        CHECK(bounded.selected()->id == selectedId);
    }
    // Expected rows are exported directly from the TypeScript implementation.
    std::ifstream fixture(SPC_METRICS_FIXTURE, std::ios::binary);
    CHECK(fixture.good());
    auto current = std::make_unique<HistoryRecord>(), previous = std::make_unique<HistoryRecord>();
    for (unsigned a = 0; a < 65536; ++a) {
        current->ram[a] = static_cast<uint8_t>(a * 37 + (a >> 8));
        previous->ram[a] = static_cast<uint8_t>(a * 19 + 7);
    }
    for (unsigned i = 0; i < 24576; ++i) current->access[i] = static_cast<uint8_t>(i * 29 + (i >> 8));
    for (unsigned mode = 0; mode < 8; ++mode) {
        uint32_t index = 0, valueCount = 0, backgroundCount = 0, flagCount = 0;
        fixture.read(reinterpret_cast<char*>(&index), 4);
        fixture.read(reinterpret_cast<char*>(&valueCount), 4);
        fixture.read(reinterpret_cast<char*>(&backgroundCount), 4);
        fixture.read(reinterpret_cast<char*>(&flagCount), 4);
        CHECK(index == mode);
        ViewConfig view{mode < 2 ? Measurement::Activity : mode < 6 ? Measurement::Data : Measurement::Entropy,
            (mode & 1) != 0, mode == 4 || mode == 5, true, 13, 65501, 7};
        const auto actual = metrics.reduce(*current, previous.get(), view);
        CHECK(actual.values.size() == valueCount && actual.background.size() == backgroundCount);
        for (const auto* array : {&actual.values, &actual.background})
            for (const float value : *array) {
                float expected = 0; fixture.read(reinterpret_cast<char*>(&expected), 4);
                CHECK(fixture.good() && std::abs(value - expected) < 0.00001f);
            }
        for (unsigned i = 0; i < flagCount; ++i) {
            uint8_t expected = 0; fixture.read(reinterpret_cast<char*>(&expected), 1);
            CHECK(expected == actual.anyChange[i]);
        }
    }
}
