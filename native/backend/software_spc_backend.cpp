#include "software_spc_backend.h"

#include "SNES_SPC.h"

#include <climits>
#include <cstring>
#include <new>

static constexpr char spc_signature[] = "SNES-SPC700 Sound File Data v0.30";
static constexpr size_t spc_signature_bytes = 27;
static constexpr size_t spc_min_bytes = 0x10180;

struct software_spc_backend {
    SNES_SPC core;
    uint64_t generated_frames;
    uint8_t aram_value_lut[256];
    bool loaded;
};

software_spc_backend_t *software_spc_create(void) {
    software_spc_backend_t *backend = new (std::nothrow) software_spc_backend_t{};
    if (backend == nullptr) {
        return nullptr;
    }

    if (backend->core.init() != nullptr) {
        delete backend;
        return nullptr;
    }
    backend->aram_value_lut[0] = 0u;
    for (unsigned value = 1u; value < 256u; ++value) {
        backend->aram_value_lut[value] = static_cast<uint8_t>(1u + (value - 1u) / 17u);
    }
    return backend;
}

void software_spc_destroy(software_spc_backend_t *backend) {
    delete backend;
}

size_t software_spc_backend_size(void) {
    return sizeof(software_spc_backend_t);
}

const char *software_spc_validate_image(const void *spc_data, size_t spc_size) {
    if (spc_data == nullptr)
        return "invalid SPC load arguments";
    if (spc_size < spc_signature_bytes ||
        std::memcmp(spc_data, spc_signature, spc_signature_bytes) != 0) {
        return "Not an SPC file";
    }
    if (spc_size < spc_min_bytes)
        return "Corrupt SPC file";
    if (spc_size > static_cast<size_t>(LONG_MAX)) {
        return "SPC file is too large";
    }
    return nullptr;
}

const char *software_spc_load(software_spc_backend_t *backend, const void *spc_data,
                              size_t spc_size, int clear_echo) {
    if (backend == nullptr)
        return "invalid SPC load arguments";
    const char *validation = software_spc_validate_image(spc_data, spc_size);
    if (validation != nullptr)
        return validation;

    const char *error = backend->core.load_spc(spc_data, static_cast<long>(spc_size));
    if (error != nullptr)
        return error;
    if (clear_echo != 0) {
        backend->core.clear_echo();
    }
    backend->generated_frames = 0;
    backend->loaded = true;
    return nullptr;
}

const char *software_spc_render(software_spc_backend_t *backend, int16_t *samples,
                                size_t stereo_frames) {
    if (backend == nullptr || !backend->loaded || samples == nullptr) {
        return "SPC backend is not ready";
    }
    if (stereo_frames > static_cast<size_t>(INT_MAX / SOFTWARE_SPC_CHANNELS)) {
        return "SPC render request is too large";
    }

    const int sample_count = static_cast<int>(stereo_frames * SOFTWARE_SPC_CHANNELS);
    const char *error = backend->core.play(sample_count, samples);
    if (error == nullptr) {
        backend->generated_frames += stereo_frames;
    }
    return error;
}

uint64_t software_spc_generated_frames(const software_spc_backend_t *backend) {
    return backend == nullptr ? 0 : backend->generated_frames;
}

void software_spc_set_aram_visualizer(software_spc_backend_t *backend, uint8_t *read_bitmap,
                                      uint8_t *write_bitmap, uint8_t *execute_bitmap) {
    if (backend != nullptr) {
        backend->core.set_aram_visualizer(read_bitmap, write_bitmap, execute_bitmap);
    }
}

bool software_spc_capture_snapshot(const software_spc_backend_t *backend, uint32_t generation,
                                   uint32_t sequence, uint32_t dropped_publications,
                                   spc_snapshot_t *snapshot) {
    if (backend == nullptr || !backend->loaded || snapshot == nullptr) {
        return false;
    }
    SNES_SPC::visual_snapshot_t raw{};
    spc_voice_internal_t internals[SPC_SNAPSHOT_VOICE_COUNT]{};
    backend->core.copy_visual_snapshot(&raw);
    for (size_t voice = 0; voice < SPC_SNAPSHOT_VOICE_COUNT; ++voice) {
        const int envelope = raw.voices[voice].envelope;
        internals[voice].brr_address = static_cast<uint16_t>(raw.voices[voice].brr_addr);
        internals[voice].envelope = static_cast<uint16_t>(envelope < 0       ? 0
                                                          : envelope > 0x7ff ? 0x7ff
                                                                             : envelope);
        const int mode = raw.voices[voice].envelope_mode;
        internals[voice].envelope_mode = static_cast<uint8_t>(
            mode >= SPC_ENV_RELEASE && mode <= SPC_ENV_SUSTAIN ? mode : SPC_ENV_RELEASE);
    }
    spc_snapshot_build(snapshot, raw.dsp_registers, internals, generation,
                       backend->generated_frames, sequence, dropped_publications);
    return true;
}

bool software_spc_capture_aram_heatmap(const software_spc_backend_t *backend,
                                       uint8_t packed[32768]) {
    if (backend == nullptr || !backend->loaded || packed == nullptr) {
        return false;
    }
    backend->core.copy_aram_heatmap(packed, backend->aram_value_lut);
    return true;
}

bool software_spc_capture_aram(const software_spc_backend_t *backend, uint8_t *destination,
                               size_t capacity) {
    constexpr size_t aram_bytes = 65536u;
    if (backend == nullptr || !backend->loaded || destination == nullptr ||
        capacity < aram_bytes) {
        return false;
    }
    backend->core.copy_aram(destination);
    return true;
}
