#include "Settings.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
namespace visual_spc {
namespace {
constexpr std::array modes{"activity", "data", "entropy"};
constexpr std::array palettes{"spectrum", "scope", "original", "grayscale", "accessible"};
[[noreturn]] void invalid() { throw std::runtime_error("The settings file contains an unsupported format or value."); }
template<size_t N> int index(const std::array<const char*, N>& values, const nlohmann::json& value) {
    for (size_t i = 0; i < N; ++i) if (value == values[i]) return static_cast<int>(i);
    return -1;
}
bool boolean(const nlohmann::json& value, const char* key, bool optional = false) {
    if (optional && !value.contains(key)) return false;
    if (!value.contains(key) || !value[key].is_boolean()) invalid();
    return value[key].get<bool>();
}
bool unit(const nlohmann::json& value, const char* key, bool optional = false) {
    if (optional && !value.contains(key)) return false;
    if (!value.contains(key) || (value[key] != "byte" && value[key] != "bit")) invalid();
    return value[key] == "bit";
}
}
nlohmann::json settingsJson(const Settings& s) {
    return {{"format", "visual-spc-player-settings"}, {"version", 3}, {"settings", {
        {"mode", modes.at(s.mode)}, {"activityUnit", s.activityBits ? "bit" : "byte"},
        {"dataUnit", s.dataBits ? "bit" : "byte"}, {"dataXor", s.xorData},
        {"entropyUnit", s.entropyBits ? "bit" : "byte"}, {"geometry", s.waterfall ? "waterfall" : "map"},
        {"waterfallSeconds", s.seconds}, {"visualizerRate", s.rate ? nlohmann::json(s.rate) : nlohmann::json("display")},
        {"palette", palettes.at(s.palette)}, {"activityByteBackground", s.underlay},
        {"byteRefreshDiagnostic", s.diagnostic}, {"activityPersistence", s.persistence},
        {"activityPersistenceMilliseconds", s.persistenceMilliseconds}, {"volume", s.volume}
    }}};
}
std::string serializeSettings(const Settings& settings) { return settingsJson(settings).dump(2) + "\n"; }
Settings parseSettings(const std::string& text) {
    const auto document = nlohmann::json::parse(text);
    if (!document.is_object() || !document.contains("format") ||
        (document["format"] != "visual-spc-player-settings" && document["format"] != "spc-memory-scope-settings") ||
        !document.contains("version") || !document["version"].is_number_integer() ||
        !document.contains("settings") || !document["settings"].is_object()) invalid();
    const auto version = document["version"].get<int>();
    if (version < 1 || version > 3) invalid();
    const auto& value = document["settings"];
    Settings s;
    if (!value.contains("mode")) invalid();
    if (version == 3) {
        s.mode = index(modes, value["mode"]); if (s.mode < 0) invalid();
        s.activityBits = unit(value, "activityUnit", true);
        s.dataBits = unit(value, "dataUnit"); s.entropyBits = unit(value, "entropyUnit");
        s.xorData = boolean(value, "dataXor");
    } else {
        const auto mode = value["mode"];
        if (mode == "activity") s.mode = 0;
        else if (mode == "bytes" || mode == "bits" || (version == 2 && mode == "xor")) {
            s.mode = 1; s.dataBits = mode == "bits"; s.xorData = mode == "xor";
        } else if (version == 2 && mode == "entropy") s.mode = 2;
        else invalid();
    }
    if (version != 1) {
        if (!value.contains("geometry") || (value["geometry"] != "map" && value["geometry"] != "waterfall")) invalid();
        s.waterfall = value["geometry"] == "waterfall";
        if (!value.contains("waterfallSeconds") || (value["waterfallSeconds"] != 2 && value["waterfallSeconds"] != 5 && value["waterfallSeconds"] != 10)) invalid();
        s.seconds = value["waterfallSeconds"].get<int>();
    }
    if (!value.contains("visualizerRate")) invalid();
    if (value["visualizerRate"] == "display") s.rate = 0;
    else if (value["visualizerRate"] == 30 || value["visualizerRate"] == 60) s.rate = value["visualizerRate"].get<int>();
    else invalid();
    if (!value.contains("palette") || (s.palette = index(palettes, value["palette"])) < 0) invalid();
    s.persistence = boolean(value, "activityPersistence");
    s.underlay = boolean(value, "activityByteBackground", true);
    s.diagnostic = boolean(value, "byteRefreshDiagnostic", true);
    if (!value.contains("volume") || !value["volume"].is_number() ||
        !value.contains("activityPersistenceMilliseconds") || !value["activityPersistenceMilliseconds"].is_number()) invalid();
    const double volume = value["volume"].get<double>(), milliseconds = value["activityPersistenceMilliseconds"].get<double>();
    if (!std::isfinite(volume) || volume < 0 || volume > 1 ||
        !std::isfinite(milliseconds) || milliseconds < 10 || milliseconds > 2000) invalid();
    s.volume = static_cast<float>(volume);
    s.persistenceMilliseconds = static_cast<int>(std::round(milliseconds / 10) * 10);
    return s;
}
}
