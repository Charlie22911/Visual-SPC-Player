#pragma once
#include "backend/spc_snapshot.h"
#include <cstdint>
// Writes exactly 288 bytes in the existing web ABI v1 little-endian format.
void spc_encode_state_packet(const spc_snapshot_t&, std::uint8_t* out);
