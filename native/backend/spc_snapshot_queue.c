#include "spc_snapshot_queue.h"
#include <stddef.h>

_Static_assert(ATOMIC_INT_LOCK_FREE == 2 && sizeof(unsigned int) == 4,
               "Snapshots require lock-free 32-bit atomics");
_Static_assert((SPC_SNAPSHOT_QUEUE_CAPACITY & (SPC_SNAPSHOT_QUEUE_CAPACITY - 1u)) == 0u,
               "Snapshot queue capacity must be a power of two");

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
