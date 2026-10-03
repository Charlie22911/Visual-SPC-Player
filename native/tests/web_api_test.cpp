#include "web_api.h"
#include "test_check.h"

#include <array>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {
constexpr std::size_t kSpcBytes = 0x10180;
constexpr std::size_t kRamOffset = 0x100;

std::vector<std::uint8_t> make_spc(std::uint8_t seed) {
    std::vector<std::uint8_t> image(kSpcBytes, 0);
    constexpr char signature[] = "SNES-SPC700 Sound File Data v0.30";
    std::memcpy(image.data(), signature, sizeof(signature) - 1);
    for (std::size_t address = 0; address < WEB_SPC_ARAM_BYTES; ++address) {
        image[kRamOffset + address] = static_cast<std::uint8_t>(address + seed);
    }
    image[kRamOffset + 0xf1] = 0;
    image[0x25] = 0x00;
    image[0x26] = 0x02;
    image[kRamOffset + 0x0200] = 0x2f;
    image[kRamOffset + 0x0201] = 0xfe;
    return image;
}

std::uint32_t read_u32(const std::uint8_t *p) {
    return static_cast<std::uint32_t>(p[0]) |
           static_cast<std::uint32_t>(p[1]) << 8 |
           static_cast<std::uint32_t>(p[2]) << 16 |
           static_cast<std::uint32_t>(p[3]) << 24;
}
} // namespace

int main() {
    web_spc_dispose();
    CHECK(web_spc_abi_version() == WEB_SPC_ABI_VERSION);
    CHECK(web_spc_commit_prepared() == WEB_SPC_ERR_NOT_READY);
    CHECK(web_spc_init() == WEB_SPC_OK);

    const auto first = make_spc(3);
    CHECK(web_spc_prepare(first.data(), static_cast<std::uint32_t>(first.size()), 0) == WEB_SPC_OK);
    CHECK(web_spc_prepare(nullptr, 0, 0) == WEB_SPC_ERR_ARGUMENT);
    CHECK(web_spc_commit_prepared() == WEB_SPC_ERR_NOT_READY);
    CHECK(web_spc_prepare(first.data(), static_cast<std::uint32_t>(first.size()), 0) == WEB_SPC_OK);
    CHECK(web_spc_commit_prepared() == WEB_SPC_OK);
    CHECK(web_spc_generation() == 1);

    std::array<std::uint8_t, WEB_SPC_ARAM_BYTES> ram{};
    CHECK(web_spc_copy_aram(ram.data(), ram.size() - 1) == WEB_SPC_ERR_CAPACITY);
    CHECK(web_spc_copy_aram(ram.data(), ram.size()) == WEB_SPC_OK);
    CHECK(ram[0x1234] == first[kRamOffset + 0x1234]);

    const std::array<std::uint8_t, 32> invalid{};
    CHECK(web_spc_prepare(invalid.data(), invalid.size(), 0) == WEB_SPC_ERR_INVALID_SPC);
    CHECK(web_spc_commit_prepared() == WEB_SPC_ERR_NOT_READY);
    CHECK(web_spc_generation() == 1);
    ram.fill(0);
    CHECK(web_spc_copy_aram(ram.data(), ram.size()) == WEB_SPC_OK);
    CHECK(ram[0x1234] == first[kRamOffset + 0x1234]);

    std::array<std::int16_t, 512> samples{};
    CHECK(web_spc_render(samples.data(), 256) == WEB_SPC_OK);
    CHECK(web_spc_generated_frames() == 256.0);

    std::array<std::uint8_t, WEB_SPC_ACTIVITY_BYTES> activity{};
    CHECK(web_spc_take_activity(activity.data(), activity.size()) == WEB_SPC_OK);
    std::array<std::uint8_t, WEB_SPC_ACTIVITY_BYTES> cleared{};
    CHECK(web_spc_take_activity(cleared.data(), cleared.size()) == WEB_SPC_OK);
    for (const auto value : cleared) CHECK(value == 0);

    std::array<std::uint8_t, WEB_SPC_STATE_BYTES> state{};
    CHECK(web_spc_copy_state(state.data(), state.size()) == WEB_SPC_OK);
    CHECK(read_u32(state.data()) == WEB_SPC_ABI_VERSION);
    CHECK(read_u32(state.data() + 4) == WEB_SPC_STATE_BYTES);
    CHECK(read_u32(state.data() + 8) == 1);
    CHECK(read_u32(state.data() + 12) == 1);

    const auto second = make_spc(9);
    CHECK(web_spc_prepare(second.data(), static_cast<std::uint32_t>(second.size()), 1) == WEB_SPC_OK);
    CHECK(web_spc_commit_prepared() == WEB_SPC_OK);
    CHECK(web_spc_generation() == 2);
    CHECK(web_spc_generated_frames() == 0.0);
    CHECK(web_spc_copy_aram(ram.data(), ram.size()) == WEB_SPC_OK);
    CHECK(ram[0x1234] == second[kRamOffset + 0x1234]);

    web_spc_dispose();
    CHECK(web_spc_copy_aram(ram.data(), ram.size()) == WEB_SPC_ERR_NOT_READY);
    return 0;
}
