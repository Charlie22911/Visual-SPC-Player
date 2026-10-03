#ifndef SPC_WEB_API_H
#define SPC_WEB_API_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    WEB_SPC_ABI_VERSION = 1,
    WEB_SPC_ARAM_BYTES = 65536,
    WEB_SPC_ACTIVITY_BYTES = 3 * 8192,
    WEB_SPC_STATE_BYTES = 288,
};

typedef enum {
    WEB_SPC_OK = 0,
    WEB_SPC_ERR_ARGUMENT = 1,
    WEB_SPC_ERR_MEMORY = 2,
    WEB_SPC_ERR_INVALID_SPC = 3,
    WEB_SPC_ERR_BACKEND = 4,
    WEB_SPC_ERR_CAPACITY = 5,
    WEB_SPC_ERR_NOT_READY = 6,
} web_spc_error_t;

uint32_t web_spc_abi_version(void);
int web_spc_init(void);
int web_spc_prepare(const uint8_t *image, uint32_t bytes, int clear_echo);
int web_spc_commit_prepared(void);
int web_spc_render(int16_t *out, uint32_t stereo_frames);
int web_spc_copy_aram(uint8_t *out, uint32_t capacity);
int web_spc_take_activity(uint8_t *out, uint32_t capacity);
int web_spc_copy_state(uint8_t *out, uint32_t capacity);
double web_spc_generated_frames(void);
uint32_t web_spc_generation(void);
void web_spc_dispose(void);

#ifdef __cplusplus
}
#endif

#endif
