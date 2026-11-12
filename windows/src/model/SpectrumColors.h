#pragma once
#include <array>
#include <cstdint>
namespace visual_spc {
// Original level-to-colour ramps for audio power, independent of ARAM palettes.
constexpr uint32_t spectrumColor(unsigned level, unsigned palette) noexcept {
    level=level>255?255:level;
    if(palette==2) return 0xff000000u | level | (level<<8) | (level<<16);
    constexpr std::array<std::array<unsigned,3>,6> green{{{0,0,0},{0,30,20},{0,92,48},{40,164,65},{185,222,83},{255,255,235}}};
    constexpr std::array<std::array<unsigned,3>,6> heat{{{0,0,0},{41,12,77},{116,22,89},{208,50,44},{255,159,45},{255,255,224}}};
    const auto& ramp=palette==1?heat:green;
    const unsigned segment=level==255?4:level/51;
    const unsigned fraction=level-segment*51;
    uint32_t color=0xff000000u;
    for(unsigned channel=0;channel<3;++channel) {
        const unsigned value=(ramp[segment][channel]*(51-fraction)+ramp[segment+1][channel]*fraction+25)/51;
        color |= value<<(channel*8);
    }
    return color;
}
static_assert(spectrumColor(0,0)==0xff000000u);
static_assert(spectrumColor(255,2)==0xffffffffu);
}
