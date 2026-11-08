#include "audio/AudioSource.h"
#include "test_check.h"
#include <array>
#include <cstring>
#include <memory>
#include <vector>
using namespace visual_spc;
int main() {
    std::vector<uint8_t> image(0x10180);
    const char signature[] = "SNES-SPC700 Sound File Data v0.30";
    std::memcpy(image.data(), signature, sizeof(signature) - 1);
    image[0x25] = 0; image[0x26] = 2;
    image[0x300] = 0x2f; image[0x301] = 0xfe;
    auto* instance = spc_native_create();
    CHECK(instance && spc_native_load(instance, image.data(), static_cast<uint32_t>(image.size()), 1) == 0);
    auto captures = std::make_unique<CaptureQueue>();
    auto source = std::make_unique<AudioSource>(48000, *captures);
    CHECK(source->replace(instance, 1) == nullptr);
    CHECK(source->setCaptureRate(240, 1));
    source->setPlaying(true);
    std::array<float, 960> left{}, right{};
    for (unsigned callback = 0; callback < 10; ++callback) {
        CHECK(source->render(left.data(), right.data(), 480));
        unsigned count = 0;
        while (const auto* capture = captures->consumer_slot()) {
            CHECK(capture->generation == 1);
            CHECK(capture->nativeFrame == capture->sequence * 32000ull / 240);
            ++count; captures->consume();
        }
        CHECK(count >= 2); // Several coherent snapshots per 10 ms wake.
    }
    source->setPlaying(false);
    CHECK(source->render(left.data(), right.data(), 960));
    const auto pausedPosition = source->position();
    const auto generated = spc_native_generated_frames(instance);
    for (unsigned i = 0; i < 10; ++i) {
        CHECK(source->render(left.data(), right.data(), 480));
        CHECK(source->position() == pausedPosition);
        CHECK(spc_native_generated_frames(instance) == generated);
    }
    // Retain accumulated access through a full queue; subsequent publication
    // marks the gap and covers the entire interval rather than clearing early.
    source->setPlaying(true);
    for (unsigned i = 0; i < 40; ++i) CHECK(source->render(left.data(), right.data(), 480));
    CHECK(source->drops() > 0);
    while (captures->consumer_slot()) captures->consume();
    CHECK(source->render(left.data(), right.data(), 480));
    CHECK(captures->consumer_slot() && captures->consumer_slot()->discontinuity > 0);
    CHECK(source->replace(nullptr, 2) == instance);
    spc_native_destroy(instance);
}
