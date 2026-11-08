#include "model/Settings.h"
#include "backend/spc_metadata.h"
#include "test_check.h"
#include <array>
#include <cstring>
#include <limits>
using namespace visual_spc;
int main() {
    Settings settings;
    auto copy = parseSettings(serializeSettings(settings));
    CHECK(copy.mode == 0 && copy.volume == 0.8f && copy.seconds == 5);
    settings.mode = 1; settings.dataBits = true; settings.xorData = true; settings.waterfall = true;
    copy = parseSettings(serializeSettings(settings));
    CHECK(copy.mode == 1 && copy.dataBits && copy.xorData && copy.waterfall);
    auto legacy = settingsJson(settings);
    legacy["version"] = 1; legacy["settings"]["mode"] = "bits";
    copy = parseSettings(legacy.dump());
    CHECK(copy.mode == 1 && copy.dataBits && !copy.xorData && !copy.waterfall);
    legacy["version"] = 2; legacy["settings"]["mode"] = "xor";
    copy = parseSettings(legacy.dump());
    CHECK(copy.mode == 1 && copy.xorData && !copy.dataBits);
    auto invalid = settingsJson(settings); invalid["settings"]["volume"] = 5;
    bool rejected = false;
    try { parseSettings(invalid.dump()); } catch (...) { rejected = true; }
    CHECK(rejected);
    invalid = settingsJson(settings); invalid["settings"]["dataUnit"] = "word";
    rejected = false; try { parseSettings(invalid.dump()); } catch (...) { rejected = true; }
    CHECK(rejected);
    std::array<uint8_t, 256> header{};
    const char signature[] = "SNES-SPC700 Sound File Data v0.30";
    std::memcpy(header.data(), signature, sizeof(signature) - 1);
    header[0x21] = header[0x22] = header[0x23] = 0x1a; header[0x24] = 0x1e;
    std::memcpy(header.data() + 0x9e, "01/01/2000", 10);
    std::memcpy(header.data() + 0xa9, "1 2", 3);
    std::memcpy(header.data() + 0xac, "00123", 5);
    spc_metadata_t metadata{};
    CHECK(spc_metadata_parse(header.data(), header.size(), &metadata));
    CHECK(!metadata.binary_id666 && metadata.song_seconds == 0 && metadata.fade_milliseconds == 123);
    header[0x21] = 0;
    CHECK(!spc_metadata_parse(header.data(), header.size(), &metadata));
}
