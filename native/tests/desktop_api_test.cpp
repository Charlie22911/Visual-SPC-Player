#include "desktop_api.h"
#include "web_api.h"
#include "test_check.h"
#include <array>
#include <cstring>
#include <thread>
#include <vector>

namespace {
std::vector<uint8_t> fixture(uint8_t seed) {
    std::vector<uint8_t> image(0x10180);
    const char signature[] = "SNES-SPC700 Sound File Data v0.30";
    std::memcpy(image.data(), signature, sizeof(signature) - 1);
    for (unsigned i = 0; i < 65536; ++i) image[0x100 + i] = static_cast<uint8_t>(i + seed);
    image[0x1f1] = 0;
    image[0x25] = 0; image[0x26] = 2;
    image[0x300] = 0x2f; image[0x301] = 0xfe;
    return image;
}
struct Capture {
    std::array<uint8_t, SPC_NATIVE_ARAM_BYTES> ram{};
    std::array<uint8_t, SPC_NATIVE_ACTIVITY_BYTES> access{};
    std::array<uint8_t, SPC_NATIVE_STATE_BYTES> state{};
    int take(spc_native_instance* instance, uint32_t generation = 1, uint32_t sequence = 1) {
        return spc_native_capture(instance, ram.data(), static_cast<uint32_t>(ram.size()),
            access.data(), static_cast<uint32_t>(access.size()), state.data(),
            static_cast<uint32_t>(state.size()), generation, sequence);
    }
};
}

int main() {
    CHECK(spc_native_abi_version() == 1);
    CHECK(spc_native_generated_frames(nullptr) == 0);
    auto* a = spc_native_create(); auto* b = spc_native_create();
    CHECK(a && b);
    Capture ca, cb;
    CHECK(ca.take(a) == SPC_NATIVE_ERR_NOT_READY);
    const auto image = fixture(3), other = fixture(9);
    CHECK(spc_native_load(a, image.data(), static_cast<uint32_t>(image.size()), 1) == 0);
    CHECK(spc_native_load(b, image.data(), static_cast<uint32_t>(image.size()), 1) == 0);
    std::vector<int16_t> whole(64000), split(64000);
    CHECK(spc_native_render(a, whole.data(), 32000) == 0);
    unsigned done = 0;
    while (done < 32000) {
        const unsigned count = (32000 - done < 133) ? 32000 - done : 133;
        CHECK(spc_native_render(b, split.data() + 2 * done, count) == 0);
        done += count;
    }
    CHECK(whole == split);
    CHECK(spc_native_generated_frames(a) == 32000);
    CHECK(ca.take(a) == 0 && cb.take(b) == 0);
    CHECK(ca.ram == cb.ram && ca.access == cb.access && ca.state == cb.state);

    // A failed capture must not consume activity or touch any output.
    CHECK(spc_native_render(a, whole.data(), 133) == 0);
    CHECK(spc_native_render(b, split.data(), 133) == 0);
    ca.ram.fill(0xa5);
    CHECK(spc_native_capture(a, ca.ram.data(), SPC_NATIVE_ARAM_BYTES,
        ca.access.data(), SPC_NATIVE_ACTIVITY_BYTES, ca.state.data(), 287, 1, 2)
        == SPC_NATIVE_ERR_CAPACITY);
    for (auto value : ca.ram) CHECK(value == 0xa5);
    CHECK(ca.take(a, 1, 2) == 0 && cb.take(b, 1, 2) == 0);
    CHECK(ca.access == cb.access && ca.state == cb.state);
    bool accessed = false;
    for (auto value : ca.access) accessed |= value != 0;
    CHECK(accessed);
    CHECK(ca.take(a) == 0);
    for (auto value : ca.access) CHECK(value == 0);

    // Shared packet encoder preserves the existing web wire representation.
    CHECK(web_spc_init() == 0);
    CHECK(web_spc_prepare(image.data(), static_cast<uint32_t>(image.size()), 1) == 0);
    CHECK(web_spc_commit_prepared() == 0);
    CHECK(spc_native_load(a, image.data(), static_cast<uint32_t>(image.size()), 1) == 0);
    CHECK(web_spc_render(whole.data(), 133) == 0);
    CHECK(spc_native_render(a, split.data(), 133) == 0);
    CHECK(ca.take(a) == 0);
    CHECK(web_spc_copy_state(cb.state.data(), SPC_NATIVE_STATE_BYTES) == 0);
    CHECK(ca.state == cb.state);
    CHECK(web_spc_take_activity(cb.access.data(), SPC_NATIVE_ACTIVITY_BYTES) == 0);
    CHECK(ca.access == cb.access);
    web_spc_dispose();

    // Audible looping BRR voice: changing render partitions must preserve PCM.
    auto tone = fixture(0);
    const uint8_t program[] = {0x8f, 0x4c, 0xf2, 0x8f, 0x01, 0xf3, 0x2f, 0xfe};
    std::memcpy(tone.data() + 0x300, program, sizeof(program));
    std::memset(tone.data() + 0x10100, 0, 128);
    tone[0x10100] = tone[0x10101] = tone[0x1010c] = tone[0x1011c] = 127;
    tone[0x10103] = 0x10; tone[0x10107] = 0x7f;
    tone[0x1015d] = 0x10; tone[0x1016c] = 0x20;
    tone[0x1100] = tone[0x1102] = 0;
    tone[0x1101] = tone[0x1103] = 0x20;
    tone[0x2100] = 0xc3;
    for (unsigned i = 1; i < 9; ++i) tone[0x2100 + i] = 0x17;
    CHECK(spc_native_load(a, tone.data(), static_cast<uint32_t>(tone.size()), 1) == 0);
    CHECK(spc_native_load(b, tone.data(), static_cast<uint32_t>(tone.size()), 1) == 0);
    CHECK(spc_native_render(a, whole.data(), 32000) == 0);
    for (unsigned i = 0; i < 32000; i += 100)
        CHECK(spc_native_render(b, split.data() + i * 2, 100) == 0);
    CHECK(whole == split);
    bool audible = false;
    for (auto sample : whole) audible |= sample != 0;
    CHECK(audible);

    // Loading a separate instance cannot disturb a running one.
    CHECK(spc_native_load(a, image.data(), static_cast<uint32_t>(image.size()), 1) == 0);
    CHECK(spc_native_render(a, whole.data(), 133) == 0);
    CHECK(spc_native_load(b, image.data(), static_cast<uint32_t>(image.size()), 1) == 0);
    CHECK(spc_native_render(b, split.data(), 133) == 0);
    int loadResult = -1;
    std::thread loader([&] { loadResult = spc_native_load(b, other.data(),
        static_cast<uint32_t>(other.size()), 1); });
    const int renderResult = spc_native_render(a, whole.data(), 32000);
    loader.join();
    CHECK(loadResult == 0 && renderResult == 0);
    CHECK(spc_native_generated_frames(a) == 32133);
    CHECK(spc_native_generated_frames(b) == 0);
    CHECK(cb.take(b) == 0 && cb.ram[0x1234] == other[0x1334]);
    CHECK(spc_native_load(a, nullptr, 0, 1) == SPC_NATIVE_ERR_ARGUMENT);
    CHECK(spc_native_generated_frames(a) == 32133);
    spc_native_destroy(a); spc_native_destroy(b); spc_native_destroy(nullptr);
}
