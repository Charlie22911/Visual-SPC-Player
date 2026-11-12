#pragma once
#include "MapRenderer.h"
#include <set>
#include <chrono>
#include "model/BandJob.h"
namespace visual_spc {
class WaterfallRenderer {
    ID3D11Device* device_;
    ID3D11DeviceContext* context_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> rows_, flags_, outputTexture_, palette_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> rowsView_, flagsView_, paletteView_, outputView_;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> target_;
    Microsoft::WRL::ComPtr<ID3D11Buffer> constants_;
    Microsoft::WRL::ComPtr<ID3D11VertexShader> vertex_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> pixel_, areaPixel_;
    unsigned outputWidth_ = 0, outputHeight_ = 0;
    ViewConfig config_{};
    unsigned width_ = 0, height_ = 0, seconds_ = 0;
    uint32_t generation_ = 0;
    uint64_t selectedId_ = 0, selectedFrame_ = 0;
    int64_t newestBand_ = 0;
    std::vector<int64_t> slots_;
    std::set<int64_t, std::greater<int64_t>> pending_;
    Metrics metrics_;
    std::vector<float> rowData_;
    std::vector<uint8_t> rowFlags_;
    std::unique_ptr<BandJob> active_;
    int64_t activeBand_ = 0;
    struct BuiltRow { int64_t band = -1; uint64_t endpoint = 0, first = 0; };
    std::vector<BuiltRow> built_;
    ReducedRow inspected_;
    int64_t inspectedBand_ = -1;
    uint64_t inspectedEndpoint_ = 0;
    void invalidateAll();
public:
    WaterfallRenderer(ID3D11Device*, ID3D11DeviceContext*);
    void configure(const ViewConfig&, unsigned height, unsigned seconds);
    void update(const History&, double budgetMilliseconds);
    void draw(unsigned palette, unsigned sampling = 0, unsigned outputWidth = 0, unsigned outputHeight = 0, bool temporal = false, unsigned temporalMs = 0);
    const ReducedRow& inspect(const History&, int64_t band);
    ID3D11ShaderResourceView* texture() const noexcept { return outputView_.Get(); }
    std::size_t pendingCount() const noexcept { return pending_.size(); }
    int64_t newestBand() const noexcept { return newestBand_; }
    double framesPerBand() const noexcept { return seconds_ * 32000.0 / height_; }
    const ViewConfig& config() const noexcept { return config_; }
};
}
