#ifndef SOFTWARE_SPC_BACKEND_H
#define SOFTWARE_SPC_BACKEND_H

#include <stddef.h>
#include <stdint.h>

#include "spc_snapshot.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
    SOFTWARE_SPC_SAMPLE_RATE = 32000,
    SOFTWARE_SPC_CHANNELS = 2,
};

typedef struct software_spc_backend software_spc_backend_t;

/* The mutable backend is owned by Core 0. Calls are synchronous; snapshot and
 * heatmap functions copy data into caller-owned storage before returning. */
software_spc_backend_t *software_spc_create(void);
void software_spc_destroy(software_spc_backend_t *backend);
size_t software_spc_backend_size(void);
const char *software_spc_validate_image(const void *spc_data, size_t spc_size);

/* The emulator copies the required snapshot data before returning. */
const char *software_spc_load(software_spc_backend_t *backend, const void *spc_data,
                              size_t spc_size, int clear_echo);

/* Writes interleaved signed 16-bit stereo samples. */
const char *software_spc_render(software_spc_backend_t *backend, int16_t *samples,
                                size_t stereo_frames);

uint64_t software_spc_generated_frames(const software_spc_backend_t *backend);
void software_spc_set_aram_visualizer(software_spc_backend_t *backend, uint8_t *read_bitmap,
                                      uint8_t *write_bitmap, uint8_t *execute_bitmap);
bool software_spc_capture_snapshot(const software_spc_backend_t *backend, uint32_t generation,
                                   uint32_t sequence, uint32_t dropped_publications,
                                   spc_snapshot_t *snapshot);
bool software_spc_capture_aram_heatmap(const software_spc_backend_t *backend,
                                       uint8_t packed[32768]);
bool software_spc_capture_aram(const software_spc_backend_t *backend, uint8_t *destination,
                               size_t capacity);

#ifdef __cplusplus
}
#endif

#endif
