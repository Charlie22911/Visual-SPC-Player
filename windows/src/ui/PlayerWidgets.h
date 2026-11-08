#pragma once
#include <array>
#include <cstdint>
#include <span>
#include <string>
namespace visual_spc {
std::array<float, 13> voiceColumnWidths();
void drawVoiceTable(std::span<const uint8_t, 128> voices);
enum class PlaybackSymbol { Play, Pause, Restart };
bool playbackButton(const char* id, PlaybackSymbol, const char* tooltip);
struct TransportActions { bool playPause = false, restart = false, volumeChanged = false; };
TransportActions drawTransport(const std::string& title, const std::string& game,
    const std::string& status, unsigned elapsedSeconds, bool playing, bool loaded, float& volume);
}
