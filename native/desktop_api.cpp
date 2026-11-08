#include "desktop_api.h"
#include "state_packet.h"
#include "backend/software_spc_backend.h"
#include <array>
#include <cstring>
#include <new>

struct spc_native_instance {
    software_spc_backend_t* backend = nullptr;
    std::array<uint8_t, SPC_NATIVE_ACTIVITY_BYTES> activity{};
    bool loaded = false;
};
uint32_t spc_native_abi_version(void) { return SPC_NATIVE_ABI_VERSION; }
spc_native_instance* spc_native_create(void) {
    auto* instance = new (std::nothrow) spc_native_instance;
    if (!instance) return nullptr;
    instance->backend = software_spc_create();
    if (!instance->backend) { delete instance; return nullptr; }
    software_spc_set_aram_visualizer(instance->backend, instance->activity.data(),
        instance->activity.data() + 8192, instance->activity.data() + 16384);
    return instance;
}
void spc_native_destroy(spc_native_instance* instance) {
    if (instance) { software_spc_destroy(instance->backend); delete instance; }
}
int spc_native_load(spc_native_instance* instance, const uint8_t* image, uint32_t bytes, int clear_echo) {
    if (!instance || !image || !bytes) return SPC_NATIVE_ERR_ARGUMENT;
    if (software_spc_validate_image(image, bytes)) return SPC_NATIVE_ERR_INVALID_SPC;
    if (software_spc_load(instance->backend, image, bytes, clear_echo)) return SPC_NATIVE_ERR_BACKEND;
    instance->activity.fill(0);
    instance->loaded = true;
    return SPC_NATIVE_OK;
}
int spc_native_render(spc_native_instance* instance, int16_t* out, uint32_t frames) {
    if (!instance || !out || !frames) return SPC_NATIVE_ERR_ARGUMENT;
    if (!instance->loaded) return SPC_NATIVE_ERR_NOT_READY;
    return software_spc_render(instance->backend, out, frames) ? SPC_NATIVE_ERR_BACKEND : SPC_NATIVE_OK;
}
uint64_t spc_native_generated_frames(const spc_native_instance* instance) {
    return instance ? software_spc_generated_frames(instance->backend) : 0;
}
int spc_native_capture(spc_native_instance* instance,
    uint8_t* aram, uint32_t aram_capacity, uint8_t* activity, uint32_t activity_capacity,
    uint8_t* state, uint32_t state_capacity, uint32_t generation, uint32_t sequence) {
    if (!instance || !aram || !activity || !state) return SPC_NATIVE_ERR_ARGUMENT;
    if (aram_capacity < SPC_NATIVE_ARAM_BYTES || activity_capacity < SPC_NATIVE_ACTIVITY_BYTES ||
        state_capacity < SPC_NATIVE_STATE_BYTES) return SPC_NATIVE_ERR_CAPACITY;
    if (!instance->loaded) return SPC_NATIVE_ERR_NOT_READY;
    spc_snapshot_t snapshot{};
    if (!software_spc_capture_snapshot(instance->backend, generation, sequence, 0, &snapshot))
        return SPC_NATIVE_ERR_BACKEND;
    if (!software_spc_capture_aram(instance->backend, aram, aram_capacity)) return SPC_NATIVE_ERR_BACKEND;
    spc_encode_state_packet(snapshot, state);
    std::memcpy(activity, instance->activity.data(), instance->activity.size());
    instance->activity.fill(0);
    return SPC_NATIVE_OK;
}
