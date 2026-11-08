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
    void open(const std::vector<std::filesystem::path>&);
    void graphicsReset(D3DDevice&);
    void setDisplayRate(unsigned numerator, unsigned denominator);
    double targetRate() const noexcept;
    bool continuous() const noexcept;
    void setSmokeVolume();
};
}
