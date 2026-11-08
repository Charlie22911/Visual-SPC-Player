#ifndef SPC_DESKTOP_API_H
#define SPC_DESKTOP_API_H
#include <stdint.h>
#if defined(_WIN32)
# if defined(SPC_NATIVE_BUILD)
#  define SPC_API __declspec(dllexport)
# else
#  define SPC_API __declspec(dllimport)
# endif
#else
# define SPC_API __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif
enum {
    SPC_NATIVE_ABI_VERSION = 1,
    SPC_NATIVE_ARAM_BYTES = 65536,
    SPC_NATIVE_ACTIVITY_BYTES = 24576,
    SPC_NATIVE_STATE_BYTES = 288
};
typedef enum {
    SPC_NATIVE_OK = 0, SPC_NATIVE_ERR_ARGUMENT = 1, SPC_NATIVE_ERR_MEMORY = 2,
    SPC_NATIVE_ERR_INVALID_SPC = 3, SPC_NATIVE_ERR_BACKEND = 4,
    SPC_NATIVE_ERR_CAPACITY = 5, SPC_NATIVE_ERR_NOT_READY = 6
} spc_native_error;
typedef struct spc_native_instance spc_native_instance;
/* Single owner per handle: calls on one handle must never overlap. Different
 * handles are independent. All buffers are caller-owned and non-overlapping.
 * Allocation/destruction stay inside the DLL. No exception crosses this ABI. */
SPC_API uint32_t spc_native_abi_version(void);
SPC_API spc_native_instance* spc_native_create(void);
SPC_API void spc_native_destroy(spc_native_instance*);
/* Load only a staging handle. Invalid arguments/images leave it unchanged. */
SPC_API int spc_native_load(spc_native_instance*, const uint8_t*, uint32_t bytes, int clear_echo);
/* Writes frames*2 signed 16-bit samples at 32000 Hz; frames must be nonzero. */
SPC_API int spc_native_render(spc_native_instance*, int16_t*, uint32_t frames);
SPC_API uint64_t spc_native_generated_frames(const spc_native_instance*);
/* Capture does not advance emulation. All capacities are validated before any
 * output is touched. Successful capture drains activity; failure retains it.
 * Writes exactly the byte sizes above; state uses the web v1 little-endian
 * packet. Generation/sequence are supplied by the owning application. */
SPC_API int spc_native_capture(spc_native_instance*,
    uint8_t* aram, uint32_t aram_capacity,
    uint8_t* activity, uint32_t activity_capacity,
    uint8_t* state, uint32_t state_capacity,
    uint32_t generation, uint32_t sequence);
#ifdef __cplusplus
}
#endif
#endif
