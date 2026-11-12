#pragma once
#include "History.h"
#include <algorithm>
#include <cmath>
#include <vector>
#include <bitset>
namespace visual_spc {
struct MapSummary {
    double mean = 0;
    unsigned cells = 0, bytes = 0, kinds = 0, held = 0;
    bool changed = false;
};
// Coordinates are source-cell edges. Fractional edge weights are exact.
inline MapSummary summarizeMap(const HistoryRecord& current, const HistoryRecord* previous,
    const std::array<uint8_t,24576>& access, const std::vector<float>& entropy,
    bool bits, bool changes, bool entropyMode, double lx, double ly, double hx, double hy, const std::array<uint8_t,65536>* persistence = nullptr) {
    MapSummary result;
    lx=std::max(0.0,lx); ly=std::max(0.0,ly);
    hx=std::min(bits ? 1024.0 : 256.0,hx); hy=std::min(bits ? 512.0 : 256.0,hy);
    double weights=0;
    std::bitset<65536> addresses;
    for(int y=int(std::floor(ly)); y<int(std::ceil(hy)); ++y)
    for(int x=int(std::floor(lx)); x<int(std::ceil(hx)); ++x) {
        const double w=std::max(0.0,std::min(hx,x+1.0)-std::max(lx,double(x))) *
            std::max(0.0,std::min(hy,y+1.0)-std::max(ly,double(y)));
        if(w<=0) continue;
        const unsigned a=bits ? (y/2)*256+x/4 : y*256+x;
        const unsigned lane=bits ? (y%2)*4+x%4 : 0;
        unsigned v=current.ram[a];
        if(changes && previous) v ^= previous->ram[a];
        if(bits) v=(v>>(7-lane))&1;
        result.mean += w*(entropyMode ? entropy[lane*256+(a>>8)] : double(v));
        weights+=w; ++result.cells; addresses.set(a);
        if(persistence) result.held |= (*persistence)[a]; result.changed |= v!=0;
        for(unsigned k=0;k<3;++k) result.kinds |= ((access[k*8192+(a>>3)]>>(a&7))&1)<<k;
    }
    result.bytes=static_cast<unsigned>(addresses.count());
    if(weights) result.mean/=weights;
    return result;
}
}
