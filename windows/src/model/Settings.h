#pragma once
#include "../../vendor/json/json.hpp"
#include <string>
namespace visual_spc {
struct Settings {
    int mode = 0, seconds = 5, rate = 30, palette = 0, persistenceMilliseconds = 100;
    bool activityBits = false, dataBits = false, entropyBits = false, xorData = false;
    bool waterfall = false, underlay = false, diagnostic = false, persistence = false;
    float volume = 0.8f;
    bool bits() const noexcept { return mode == 0 ? activityBits : mode == 1 ? dataBits : entropyBits; }
    bool& selectedBits() noexcept { return mode == 0 ? activityBits : mode == 1 ? dataBits : entropyBits; }
};
nlohmann::json settingsJson(const Settings&);
std::string serializeSettings(const Settings&);
Settings parseSettings(const std::string&);
}
