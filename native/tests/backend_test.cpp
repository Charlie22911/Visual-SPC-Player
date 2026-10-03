#include "software_spc_backend.h"
#include "test_check.h"

#include <array>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

namespace {
constexpr std::size_t kSpcBytes = 0x10180;
constexpr std::size_t kRamOffset = 0x100;
constexpr std::size_t kRamBytes = 65536;

std::vector<std::uint8_t> make_spc() {
    std::vector<std::uint8_t> image(kSpcBytes, 0);
    constexpr char signature[] = "SNES-SPC700 Sound File Data v0.30";
    std::memcpy(image.data(), signature, sizeof(signature) - 1);
    for (std::size_t address = 0; address < kRamBytes; ++address) {
        image[kRamOffset + address] = static_cast<std::uint8_t>(address ^ (address >> 8));
    }
    image[kRamOffset + 0xf1] = 0;
    return image;
}
} // namespace

int main() {
    using Backend = std::unique_ptr<software_spc_backend_t, decltype(&software_spc_destroy)>;
    Backend backend(software_spc_create(), software_spc_destroy);
    CHECK(backend);

    std::array<std::uint8_t, kRamBytes + 2> guarded{};
    guarded.front() = 0x5a;
    guarded.back() = 0xa5;
    CHECK(!software_spc_capture_aram(nullptr, guarded.data() + 1, kRamBytes));
    CHECK(!software_spc_capture_aram(backend.get(), guarded.data() + 1, kRamBytes));

    const auto image = make_spc();
    CHECK(software_spc_load(backend.get(), image.data(), image.size(), 0) == nullptr);
    CHECK(!software_spc_capture_aram(backend.get(), guarded.data() + 1, kRamBytes - 1));
    CHECK(software_spc_capture_aram(backend.get(), guarded.data() + 1, kRamBytes));
    CHECK(guarded.front() == 0x5a);
    CHECK(guarded.back() == 0xa5);
    CHECK(guarded[1 + 0x0000] == image[kRamOffset + 0x0000]);
    CHECK(guarded[1 + 0x1234] == image[kRamOffset + 0x1234]);
    CHECK(guarded[1 + 0xffbf] == image[kRamOffset + 0xffbf]);

    const auto first = guarded;
    CHECK(software_spc_capture_aram(backend.get(), guarded.data() + 1, kRamBytes));
    CHECK(guarded == first);
    return 0;
}
