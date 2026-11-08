#include "model/PresentationState.h"
#include "test_check.h"
using namespace visual_spc;
int main() {
    PlaybackIntent intent;
    intent.request(1, true); intent.complete(1, false);
    CHECK(!intent.playing()); // Failed replacement preserves paused playback.
    intent.setPlaying(true); intent.request(2, true); intent.complete(2, false);
    CHECK(intent.playing());
    intent.request(3, true); intent.setPlaying(false); intent.complete(3, true);
    CHECK(!intent.playing()); // A pause during a load wins over autoplay.
    intent.request(4, true); intent.complete(3, true); CHECK(!intent.playing());
    intent.complete(4, true); CHECK(intent.playing());
    intent.setPlaying(false); intent.request(5, false); intent.complete(5, true); CHECK(!intent.playing());
    PreparedLoadState pending;
    auto* a = reinterpret_cast<spc_native_instance*>(uintptr_t(1));
    auto* b = reinterpret_cast<spc_native_instance*>(uintptr_t(2));
    CHECK(!pending.begin(1));
    LoadResult first; first.id = 1; first.instance = a;
    CHECK(!pending.receive(std::move(first)));
    CHECK(!pending.commit([](auto*) { return false; })); // Audio queue full.
    CHECK(pending.begin(2) == a); // Caller retires stale ownership.
    unsigned enqueued = 0;
    CHECK(!pending.commit([&](auto*) { ++enqueued; return true; }));
    CHECK(enqueued == 0);
    LoadResult second; second.id = 2; second.instance = b;
    CHECK(!pending.receive(std::move(second)));
    spc_native_instance* delivered = nullptr;
    auto accepted = pending.commit([&](auto* pointer) { delivered = pointer; ++enqueued; return true; });
    CHECK(delivered == b);
    CHECK(accepted && accepted->id == 2 && !accepted->instance && enqueued == 1);
    MapActivityUnion activity;
    std::array<uint8_t, 24576> access{};
    access[0] = 1; activity.add(access);
    access.fill(0); access[1] = 2; activity.add(access);
    CHECK(activity.bytes()[0] == 1 && activity.bytes()[1] == 2);
    activity.drawn(); access.fill(0); access[2] = 4; activity.add(access);
    CHECK(activity.bytes()[0] == 0 && activity.bytes()[1] == 0 && activity.bytes()[2] == 4);
    const auto normal = plotSampling(1200, 800, 1, false, 65536);
    const auto high = plotSampling(2400, 1600, 2, false, 65536);
    CHECK(normal.columns == high.columns && normal.rows == high.rows);
    const auto bitNormal = plotSampling(1200, 800, 1, true, 65536);
    const auto bitHigh = plotSampling(2400, 1600, 2, true, 65536);
    CHECK(bitNormal.columns == bitHigh.columns && bitNormal.rows == bitHigh.rows);
    CHECK(plotRowAt(400, 800, normal.rows) == plotRowAt(800, 1600, high.rows));
    CHECK(physicalMapScale(1, 2) == 2);
    ScanSelection scan;
    scan.begin(1); CHECK(scan.accepts(1));
    scan.invalidate(); CHECK(!scan.accepts(1)); // Late batch after Open files.
    scan.begin(2); CHECK(!scan.accepts(1) && scan.accepts(2));
    float zoom = 1;
    for (unsigned i = 0; i < 1000; ++i) zoom = clampMapScale(zoom * 2);
    CHECK(zoom == 256);
    for (unsigned i = 0; i < 1000; ++i) zoom = clampMapScale(zoom * 0.5f);
    CHECK(zoom == 0.01f);
    CHECK(effectiveDrawRate(240, false) == 10);
    CHECK(effectiveDrawRate(240, true) == 240);
}
