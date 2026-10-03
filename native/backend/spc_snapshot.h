#ifndef SPC_SNAPSHOT_H
#define SPC_SNAPSHOT_H

#include <stdbool.h>
#include <stdint.h>

#define SPC_SNAPSHOT_VOICE_COUNT 8u
#define SPC_SNAPSHOT_DSP_REGISTER_COUNT 128u

enum {
    SPC_SNAPSHOT_VALID_DSP_REGISTERS = 1u << 0,
    SPC_SNAPSHOT_VALID_VOICE_INTERNALS = 1u << 1,
};

typedef enum {
    SPC_ENV_RELEASE = 0,
    SPC_ENV_ATTACK,
    SPC_ENV_DECAY,
    SPC_ENV_SUSTAIN,
} spc_envelope_mode_t;

typedef struct {
    uint16_t brr_address;
    uint16_t envelope;
    uint8_t envelope_mode;
} spc_voice_internal_t;

typedef struct {
    int8_t volume_left;
    int8_t volume_right;
    uint16_t pitch;
    uint16_t envelope;
    uint16_t brr_address;
    uint8_t source_number;
    uint8_t adsr0;
    uint8_t adsr1;
    uint8_t gain;
    uint8_t envx;
    int8_t outx;
    uint8_t envelope_mode;
    bool key_on;
    bool key_off;
    bool endx;
} spc_voice_snapshot_t;

typedef struct {
    uint32_t sequence;
    uint32_t generation;
    uint32_t validity;
    uint32_t dropped_publications;
    uint64_t track_frames;
    uint64_t apu_cycles;
    uint8_t dsp_registers[SPC_SNAPSHOT_DSP_REGISTER_COUNT];
    spc_voice_snapshot_t voices[SPC_SNAPSHOT_VOICE_COUNT];
} spc_snapshot_t;

#ifdef __cplusplus
extern "C" {
#endif

/* Decodes documented DSP registers and optional narrow emulator internals into
 * a plain C object. Values are copied; no pointer aliases the running core. */
void spc_snapshot_build(spc_snapshot_t *snapshot, const uint8_t dsp_registers[128],
                        const spc_voice_internal_t internals[8], uint32_t generation,
                        uint64_t track_frames, uint32_t sequence, uint32_t dropped_publications);

#ifdef __cplusplus
}
#endif

#endif
