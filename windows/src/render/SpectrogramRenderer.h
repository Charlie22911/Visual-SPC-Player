#pragma once
#include "D3DDevice.h"
#include "audio/SpectrumWorker.h"
#include <deque>
#include <vector>
namespace visual_spc {
struct SpectrumView {
    unsigned width=1024,height=512,fftSize=2048,hopSize=256,sampling=1,seconds=5,temporalMs=25,palette=0;
    bool logarithmic=true,temporal=true,difference=false;
    float floorDb=-90,ceilingDb=0;
    bool operator==(const SpectrumView&) const = default;
};
struct SpectrumRenderStats {
    uint64_t uploaded=0,projected=0,draws=0,dropped=0;
    size_t bytes=0,pending=0;
    double uploadMs=0,projectionMs=0,drawMs=0;
};
class SpectrogramRenderer {
    struct Impl;
    std::unique_ptr<Impl> impl_;
public:
    SpectrogramRenderer(ID3D11Device*, ID3D11DeviceContext*);
    ~SpectrogramRenderer();
    void configure(const SpectrumView&,uint64_t epoch,uint32_t generation);
    // Future generation/time staging belongs to the caller. Returns false on over-ahead input.
    bool upload(const SpectrumResult&,double audibleFrame);
    void update(double budgetMs=0.75);
    void draw(double audibleFrame);
    ID3D11ShaderResourceView* texture() const;
    // Numeric row cache for diagnostics/readback checks; live display never reads back.
    ID3D11ShaderResourceView* projectedTexture() const;
    SpectrumRenderStats stats() const;
};
}
