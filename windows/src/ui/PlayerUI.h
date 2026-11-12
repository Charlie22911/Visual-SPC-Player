#pragma once
#include "render/D3DDevice.h"
#include <memory>
#include <filesystem>
#include <vector>
namespace visual_spc {
class PlayerUI {
    struct Impl;
    std::unique_ptr<Impl> impl_;
public:
    PlayerUI(HWND, D3DDevice&);
    ~PlayerUI();
    void tick();
    void draw();
    void maintainGraphics(bool visible=true);
    void open(const std::vector<std::filesystem::path>&);
    void graphicsReset(D3DDevice&);
    void setDisplayRate(unsigned numerator, unsigned denominator);
    double targetRate() const noexcept;
    bool continuous() const noexcept;
    void setSmokeVolume(bool spectrogram = false, bool stress = false);
    void setSmokePanel(unsigned);
    void writeSpectrumReport(const std::filesystem::path&);
};
}
