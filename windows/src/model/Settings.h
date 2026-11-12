#pragma once
#include "../../vendor/json/json.hpp"
#include <string>
namespace visual_spc {
struct Settings {
    bool spectrogram = false;
    int spectrumPalette=0;
    int spectrumPreset=0, spectrumFft=2048, spectrumHop=256, spectrumSampling=1, spectrumSeconds=5, spectrumTemporalMs=25;
    bool spectrumDifference=false, spectrumLog=true, spectrumTemporal=true;
    float spectrumFloor=-90, spectrumCeiling=0;
    int waterfallTemporalMs = 50;
    bool waterfallTemporal = false;
    int waterfallSampling = 0;
    int mapSampling = 0; // nearest, smooth, area (native presentation only)
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
