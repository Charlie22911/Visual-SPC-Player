#include "spc_metadata.h"

#include <limits.h>
#include <string.h>

enum {
    SPC_HEADER_SIZE = 0x100,
    SPC_HAS_ID666_OFFSET = 0x23,
    SPC_TITLE_OFFSET = 0x2e,
    SPC_GAME_OFFSET = 0x4e,
    SPC_DUMPER_OFFSET = 0x6e,
    SPC_COMMENTS_OFFSET = 0x7e,
    SPC_DATE_OFFSET = 0x9e,
    SPC_TEXT_SECONDS_OFFSET = 0xa9,
    SPC_TEXT_FADE_OFFSET = 0xac,
    SPC_BINARY_ARTIST_OFFSET = 0xb0,
    SPC_TEXT_ARTIST_OFFSET = 0xb1,
};

static bool looks_like_text_date(const uint8_t *source) {
    bool has_text = false;
    for (size_t i = 0u; i < 11u; ++i) {
        const uint8_t character = source[i];
        if (character == 0u || character == ' ')
            continue;
        if ((character >= '0' && character <= '9') || character == '/' || character == '-') {
            has_text = true;
            continue;
        }
        return false;
    }
    return has_text;
}

static const char spc_signature[] = "SNES-SPC700 Sound File Data v0.30";

static void copy_field(char *destination, size_t capacity, const uint8_t *source,
                       size_t source_size) {
    size_t length = 0u;
    while (length < source_size && source[length] != 0u)
        ++length;
    while (length != 0u && source[length - 1u] == ' ')
        --length;
    if (length >= capacity)
        length = capacity - 1u;
    for (size_t i = 0u; i < length; ++i) {
        const uint8_t value = source[i];
        destination[i] = value >= 0x20u && value <= 0x7eu ? (char)value : '?';
    }
    destination[length] = '\0';
}

static bool parse_decimal(const uint8_t *source, size_t length, uint32_t *value) {
    uint32_t result = 0u;
    bool found_digit = false;
    for (size_t i = 0u; i < length; ++i) {
        const uint8_t character = source[i];
        if (character == 0u || character == ' ')
            continue;
        if (character < '0' || character > '9')
            return false;
        found_digit = true;
        const uint32_t digit = (uint32_t)(character - '0');
        if (result > (UINT32_MAX - digit) / 10u)
            return false;
        result = result * 10u + digit;
    }
    if (!found_digit)
        return false;
    *value = result;
    return true;
}

static uint32_t read_little_endian(const uint8_t *source, size_t length) {
    uint32_t result = 0u;
    for (size_t i = 0u; i < length; ++i) {
        result |= (uint32_t)source[i] << (uint32_t)(i * 8u);
    }
    return result;
}

bool spc_metadata_parse(const uint8_t *data, size_t size, spc_metadata_t *metadata) {
    if (metadata == NULL)
        return false;
    *metadata = (spc_metadata_t){0};
    if (data == NULL || size < SPC_HEADER_SIZE ||
        memcmp(data, spc_signature, sizeof(spc_signature) - 1u) != 0) {
        return false;
    }
    if (data[SPC_HAS_ID666_OFFSET] != 0x1au)
        return true;

    metadata->has_id666 = true;
    copy_field(metadata->title, sizeof(metadata->title), data + SPC_TITLE_OFFSET, 32u);
    copy_field(metadata->game, sizeof(metadata->game), data + SPC_GAME_OFFSET, 32u);
    copy_field(metadata->dumper, sizeof(metadata->dumper), data + SPC_DUMPER_OFFSET, 16u);
    copy_field(metadata->comments, sizeof(metadata->comments), data + SPC_COMMENTS_OFFSET, 32u);

    uint32_t seconds = 0u;
    uint32_t fade = 0u;
    const bool text_layout = looks_like_text_date(data + SPC_DATE_OFFSET);
    const bool text_timing = parse_decimal(data + SPC_TEXT_SECONDS_OFFSET, 3u, &seconds) &&
                             parse_decimal(data + SPC_TEXT_FADE_OFFSET, 5u, &fade);
    metadata->binary_id666 = !text_layout && !text_timing;
    if (metadata->binary_id666) {
        seconds = read_little_endian(data + SPC_TEXT_SECONDS_OFFSET, 3u);
        fade = read_little_endian(data + SPC_TEXT_FADE_OFFSET, 4u);
    }
    metadata->song_seconds = seconds;
    metadata->fade_milliseconds = fade;
    metadata->timing_valid = metadata->binary_id666 || text_timing;
    const size_t artist_offset =
        metadata->binary_id666 ? SPC_BINARY_ARTIST_OFFSET : SPC_TEXT_ARTIST_OFFSET;
    copy_field(metadata->artist, sizeof(metadata->artist), data + artist_offset, 32u);
    return true;
}
