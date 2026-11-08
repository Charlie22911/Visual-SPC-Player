#include "audio/AudioEngine.h"
#include <Windows.h>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
using namespace visual_spc;
int wmain(int argc, wchar_t** argv) {
    try {
        std::vector<uint8_t> image;
        if (argc > 1) {
            std::ifstream file(std::filesystem::path(argv[1]), std::ios::binary);
            image.assign(std::istreambuf_iterator<char>(file), {});
        } else {
            image.resize(0x10180);
            const char signature[] = "SNES-SPC700 Sound File Data v0.30";
            std::memcpy(image.data(), signature, sizeof(signature) - 1);
            image[0x25] = 0; image[0x26] = 2; image[0x300] = 0x2f; image[0x301] = 0xfe;
        }
        auto* instance = spc_native_create();
        if (!instance || spc_native_load(instance, image.data(), static_cast<uint32_t>(image.size()), 1))
            throw std::runtime_error("SPC load failed");
        AudioEngine engine;
        if (!engine.replace(instance, 1)) { spc_native_destroy(instance); throw std::runtime_error("Command queue full"); }
        engine.setVolume(0.1f);
        engine.setPlaying(true);
        const auto start = std::chrono::steady_clock::now();
        uint64_t captures = 0; ClockAnchor latest{}; bool anchored = false;
        while (std::chrono::steady_clock::now() - start < std::chrono::seconds(3)) {
            while (engine.captures().consumer_slot()) { ++captures; engine.captures().consume(); }
            ClockAnchor anchor;
            while (engine.popAnchor(anchor)) { latest = anchor; anchored = true; }
            spc_native_instance* retired = nullptr;
            while (engine.popRetired(retired)) spc_native_destroy(retired);
            Sleep(5);
        }
        if (!anchored || latest.generation != 1 || latest.mediaFrame < 32000 || captures < 200)
            throw std::runtime_error("Device playback/capture clock did not advance");
        std::cout << "WASAPI format " << engine.sampleRate() << " Hz; media frame "
                  << latest.mediaFrame << "; captures " << captures << "\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << "\n"; return 1; }
}
