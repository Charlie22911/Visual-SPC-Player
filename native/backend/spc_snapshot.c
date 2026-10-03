#include "spc_snapshot.h"
#include "spc_snapshot_queue.h"

#include <stddef.h>

_Static_assert(ATOMIC_INT_LOCK_FREE == 2 && sizeof(unsigned int) == 4,
               "Snapshots require lock-free 32-bit atomics");
_Static_assert((SPC_SNAPSHOT_QUEUE_CAPACITY & (SPC_SNAPSHOT_QUEUE_CAPACITY - 1u)) == 0u,
               "Snapshot queue capacity must be a power of two");

enum {
    DSP_KON = 0x4c,
    DSP_KOFF = 0x5c,
    DSP_ENDX = 0x7c,
};

void spc_snapshot_build(spc_snapshot_t *snapshot, const uint8_t dsp_registers[128],
                        const spc_voice_internal_t internals[8], uint32_t generation,
                        uint64_t track_frames, uint32_t sequence, uint32_t dropped_publications) {
    if (snapshot == NULL)
        return;
    *snapshot = (spc_snapshot_t){
        .sequence = sequence,
        .generation = generation,
        .dropped_publications = dropped_publications,
        .track_frames = track_frames,
        .apu_cycles = track_frames * UINT64_C(32),
    };
    if (dsp_registers == NULL)
        return;
    snapshot->validity |= SPC_SNAPSHOT_VALID_DSP_REGISTERS;
    for (uint32_t i = 0u; i < 128u; ++i) {
        snapshot->dsp_registers[i] = dsp_registers[i];
    }
    if (internals != NULL) {
        snapshot->validity |= SPC_SNAPSHOT_VALID_VOICE_INTERNALS;
    }
    for (uint32_t voice = 0u; voice < 8u; ++voice) {
        const uint32_t base = voice << 4u;
        spc_voice_snapshot_t *out = &snapshot->voices[voice];
        out->volume_left = (int8_t)dsp_registers[base + 0u];
        out->volume_right = (int8_t)dsp_registers[base + 1u];
        out->pitch = (uint16_t)(dsp_registers[base + 2u] |
                                (uint16_t)(dsp_registers[base + 3u] & 0x3fu) << 8u);
        out->source_number = dsp_registers[base + 4u];
        out->adsr0 = dsp_registers[base + 5u];
        out->adsr1 = dsp_registers[base + 6u];
        out->gain = dsp_registers[base + 7u];
        out->envx = dsp_registers[base + 8u];
        out->outx = (int8_t)dsp_registers[base + 9u];
        out->key_on = (dsp_registers[DSP_KON] & (1u << voice)) != 0u;
        out->key_off = (dsp_registers[DSP_KOFF] & (1u << voice)) != 0u;
        out->endx = (dsp_registers[DSP_ENDX] & (1u << voice)) != 0u;
        if (internals != NULL) {
            out->brr_address = internals[voice].brr_address;
            out->envelope = internals[voice].envelope > 0x7ffu ? 0x7ffu : internals[voice].envelope;
            out->envelope_mode = internals[voice].envelope_mode <= SPC_ENV_SUSTAIN
                                     ? internals[voice].envelope_mode
                                     : SPC_ENV_RELEASE;
        } else {
            out->envelope = (uint16_t)out->envx << 4u;
        }
    }
}

void spc_snapshot_queue_init(spc_snapshot_queue_t *queue) {
    atomic_init(&queue->head, 0u);
    atomic_init(&queue->tail, 0u);
}

bool spc_snapshot_queue_push(spc_snapshot_queue_t *queue, const spc_snapshot_t *snapshot) {
    if (queue == NULL || snapshot == NULL)
        return false;
    const uint32_t head = atomic_load_explicit(&queue->head, memory_order_relaxed);
    const uint32_t tail = atomic_load_explicit(&queue->tail, memory_order_acquire);
    if ((uint32_t)(head - tail) == SPC_SNAPSHOT_QUEUE_CAPACITY)
        return false;
    queue->entries[head & (SPC_SNAPSHOT_QUEUE_CAPACITY - 1u)] = *snapshot;
    atomic_store_explicit(&queue->head, head + 1u, memory_order_release);
    return true;
}

bool spc_snapshot_queue_pop_latest(spc_snapshot_queue_t *queue, spc_snapshot_t *snapshot) {
    if (queue == NULL || snapshot == NULL)
        return false;
    const uint32_t tail = atomic_load_explicit(&queue->tail, memory_order_relaxed);
    const uint32_t head = atomic_load_explicit(&queue->head, memory_order_acquire);
    if (tail == head)
        return false;
    *snapshot = queue->entries[(head - 1u) & (SPC_SNAPSHOT_QUEUE_CAPACITY - 1u)];
    atomic_store_explicit(&queue->tail, head, memory_order_release);
    return true;
}
