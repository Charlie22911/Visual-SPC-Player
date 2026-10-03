#ifndef SPC_METADATA_H
#define SPC_METADATA_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    bool has_id666;
    bool binary_id666;
    bool timing_valid;
    char title[33];
    char game[33];
    char artist[33];
    char dumper[17];
    char comments[33];
    uint32_t song_seconds;
    uint32_t fade_milliseconds;
} spc_metadata_t;

bool spc_metadata_parse(const uint8_t *data, size_t size, spc_metadata_t *metadata);

#endif
