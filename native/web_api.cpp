#include "web_api.h"
#include "state_packet.h"

#include "backend/software_spc_backend.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <utility>

namespace {
constexpr std::size_t kActivityMapBytes = 8192;

software_spc_backend_t *active = nullptr;
software_spc_backend_t *staging = nullptr;
bool staging_prepared = false;
std::uint32_t generation = 0;
std::uint32_t sequence = 0;
std::array<std::uint8_t, kActivityMapBytes> activity_read{};
std::array<std::uint8_t, kActivityMapBytes> activity_write{};
std::array<std::uint8_t, kActivityMapBytes> activity_execute{};

void reset_activity() {
    activity_read.fill(0);
    activity_write.fill(0);
    activity_execute.fill(0);
}

bool ready() {
    return active != nullptr && staging != nullptr;
}
} // namespace

std::uint32_t web_spc_abi_version(void) {
    return WEB_SPC_ABI_VERSION;
}

int web_spc_init(void) {
    if (ready()) return WEB_SPC_OK;
    web_spc_dispose();
    active = software_spc_create();
    staging = software_spc_create();
    if (active == nullptr || staging == nullptr) {
        web_spc_dispose();
        return WEB_SPC_ERR_MEMORY;
    }
    return WEB_SPC_OK;
}

int web_spc_prepare(const std::uint8_t *image, std::uint32_t bytes, int clear_echo) {
    if (!ready()) return WEB_SPC_ERR_NOT_READY;
    staging_prepared = false;
    if (image == nullptr || bytes == 0) return WEB_SPC_ERR_ARGUMENT;
    if (software_spc_validate_image(image, bytes) != nullptr) return WEB_SPC_ERR_INVALID_SPC;
    if (software_spc_load(staging, image, bytes, clear_echo) != nullptr) {
        return WEB_SPC_ERR_BACKEND;
    }
    staging_prepared = true;
    return WEB_SPC_OK;
}

int web_spc_commit_prepared(void) {
    if (!ready() || !staging_prepared) return WEB_SPC_ERR_NOT_READY;
    software_spc_set_aram_visualizer(active, nullptr, nullptr, nullptr);
    std::swap(active, staging);
    reset_activity();
    software_spc_set_aram_visualizer(active, activity_read.data(), activity_write.data(),
                                     activity_execute.data());
    staging_prepared = false;
    ++generation;
    sequence = 0;
    return WEB_SPC_OK;
}

int web_spc_render(std::int16_t *out, std::uint32_t stereo_frames) {
    if (!ready()) return WEB_SPC_ERR_NOT_READY;
    if (out == nullptr || stereo_frames == 0) return WEB_SPC_ERR_ARGUMENT;
    return software_spc_render(active, out, stereo_frames) == nullptr ? WEB_SPC_OK
                                                                      : WEB_SPC_ERR_BACKEND;
}

int web_spc_copy_aram(std::uint8_t *out, std::uint32_t capacity) {
    if (!ready()) return WEB_SPC_ERR_NOT_READY;
    if (out == nullptr) return WEB_SPC_ERR_ARGUMENT;
    if (capacity < WEB_SPC_ARAM_BYTES) return WEB_SPC_ERR_CAPACITY;
    return software_spc_capture_aram(active, out, capacity) ? WEB_SPC_OK : WEB_SPC_ERR_BACKEND;
}

int web_spc_take_activity(std::uint8_t *out, std::uint32_t capacity) {
    if (!ready()) return WEB_SPC_ERR_NOT_READY;
    if (out == nullptr) return WEB_SPC_ERR_ARGUMENT;
    if (capacity < WEB_SPC_ACTIVITY_BYTES) return WEB_SPC_ERR_CAPACITY;
    std::memcpy(out, activity_read.data(), kActivityMapBytes);
    std::memcpy(out + kActivityMapBytes, activity_write.data(), kActivityMapBytes);
    std::memcpy(out + 2 * kActivityMapBytes, activity_execute.data(), kActivityMapBytes);
    reset_activity();
    return WEB_SPC_OK;
}

int web_spc_copy_state(std::uint8_t *out, std::uint32_t capacity) {
    if (!ready()) return WEB_SPC_ERR_NOT_READY;
    if (out == nullptr) return WEB_SPC_ERR_ARGUMENT;
    if (capacity < WEB_SPC_STATE_BYTES) return WEB_SPC_ERR_CAPACITY;
    spc_snapshot_t snapshot{};
    if (!software_spc_capture_snapshot(active, generation, sequence + 1, 0, &snapshot)) {
        return WEB_SPC_ERR_BACKEND;
    }
    ++sequence;
    spc_encode_state_packet(snapshot, out);
    return WEB_SPC_OK;
}

double web_spc_generated_frames(void) {
    return active == nullptr ? 0.0 : static_cast<double>(software_spc_generated_frames(active));
}

std::uint32_t web_spc_generation(void) {
    return generation;
}

void web_spc_dispose(void) {
    software_spc_destroy(active);
    software_spc_destroy(staging);
    active = nullptr;
    staging = nullptr;
    staging_prepared = false;
    generation = 0;
    sequence = 0;
    reset_activity();
}
