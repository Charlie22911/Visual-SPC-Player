#pragma once
#include "desktop_api.h"
#include "concurrency/SpscRing.h"
#include <array>
#include <cstdint>
namespace visual_spc {
struct Capture {
    uint64_t nativeFrame = 0, intervalBegin = 0;
    uint32_t generation = 0, sequence = 0, discontinuity = 0;
    std::array<uint8_t, SPC_NATIVE_ARAM_BYTES> ram{};
    std::array<uint8_t, SPC_NATIVE_ACTIVITY_BYTES> access{};
    std::array<uint8_t, SPC_NATIVE_STATE_BYTES> state{};
};
using CaptureQueue = SpscRing<Capture, 64>; // Heap-owned: >5 MiB.
}
