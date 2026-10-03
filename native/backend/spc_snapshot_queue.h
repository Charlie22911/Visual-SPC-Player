#ifndef SPC_SNAPSHOT_QUEUE_H
#define SPC_SNAPSHOT_QUEUE_H

#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>

#include "spc_snapshot.h"

#define SPC_SNAPSHOT_QUEUE_CAPACITY 4u

/* Core 0 produces complete copied snapshots and Core 1 consumes them.
 * Publication is nonblocking; when full, audio continues and records a drop.
 * No pointer in a published snapshot refers to mutable emulator storage. */
typedef struct {
    _Atomic uint32_t head;
    _Atomic uint32_t tail;
    spc_snapshot_t entries[SPC_SNAPSHOT_QUEUE_CAPACITY];
} spc_snapshot_queue_t;

void spc_snapshot_queue_init(spc_snapshot_queue_t *queue);
bool spc_snapshot_queue_push(spc_snapshot_queue_t *queue, const spc_snapshot_t *snapshot);
bool spc_snapshot_queue_pop_latest(spc_snapshot_queue_t *queue, spc_snapshot_t *snapshot);

#endif
