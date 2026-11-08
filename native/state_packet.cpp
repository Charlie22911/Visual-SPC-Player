#include "state_packet.h"
#include "web_api.h"
#include <cstddef>
#include <cstring>
namespace {
void put_u32(std::uint8_t *out, std::uint32_t value) {
    out[0] = static_cast<std::uint8_t>(value);
    out[1] = static_cast<std::uint8_t>(value >> 8);
    out[2] = static_cast<std::uint8_t>(value >> 16);
    out[3] = static_cast<std::uint8_t>(value >> 24);
}

void put_double(std::uint8_t *out, double value) {
    static_assert(sizeof(double) == sizeof(std::uint64_t));
    std::uint64_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    for (std::size_t i = 0; i < sizeof(bits); ++i) {
        out[i] = static_cast<std::uint8_t>(bits >> (i * 8));
    }
}

}
void spc_encode_state_packet(const spc_snapshot_t& snapshot, std::uint8_t* out) {
    std::memset(out, 0, WEB_SPC_STATE_BYTES);
    put_u32(out, WEB_SPC_ABI_VERSION);
    put_u32(out + 4, WEB_SPC_STATE_BYTES);
    put_u32(out + 8, snapshot.generation);
    put_u32(out + 12, snapshot.sequence);
    put_u32(out + 16, snapshot.validity);
    put_double(out + 24, static_cast<double>(snapshot.track_frames));
    std::memcpy(out + 32, snapshot.dsp_registers, SPC_SNAPSHOT_DSP_REGISTER_COUNT);
    for (std::size_t index = 0; index < SPC_SNAPSHOT_VOICE_COUNT; ++index) {
        const auto &voice = snapshot.voices[index];
        std::uint8_t *encoded = out + 160 + index * 16;
        encoded[0] = static_cast<std::uint8_t>(voice.volume_left);
        encoded[1] = static_cast<std::uint8_t>(voice.volume_right);
        encoded[2] = static_cast<std::uint8_t>(voice.pitch);
        encoded[3] = static_cast<std::uint8_t>(voice.pitch >> 8);
        encoded[4] = static_cast<std::uint8_t>(voice.envelope);
        encoded[5] = static_cast<std::uint8_t>(voice.envelope >> 8);
        encoded[6] = static_cast<std::uint8_t>(voice.brr_address);
        encoded[7] = static_cast<std::uint8_t>(voice.brr_address >> 8);
        encoded[8] = voice.source_number;
        encoded[9] = voice.adsr0;
        encoded[10] = voice.adsr1;
        encoded[11] = voice.gain;
        encoded[12] = voice.envx;
        encoded[13] = static_cast<std::uint8_t>(voice.outx);
        encoded[14] = voice.envelope_mode;
        encoded[15] = static_cast<std::uint8_t>((voice.key_on ? 1 : 0) |
                                                (voice.key_off ? 2 : 0) |
                                                (voice.endx ? 4 : 0));
    }
}
