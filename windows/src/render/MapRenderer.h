#pragma once
#include "D3DDevice.h"
#include "model/Metrics.h"
namespace visual_spc {
struct alignas(16) ShaderConfig {
    uint32_t mode, bits, changes, underlay;
    uint32_t palette, previousValid, persistent, ringHeight;
    uint32_t newestSlot, renderWidth, unused0, unused1;
};
class MapRenderer {
    ID3D11Device* device_;
    ID3D11DeviceContext* context_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> current_, previous_, persistence_, palette_, target_;
    Microsoft::WRL::ComPtr<ID3D11Buffer> access_, entropy_, constants_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> inputs_[6], output_;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> targetView_;
    Microsoft::WRL::ComPtr<ID3D11VertexShader> vertex_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> pixel_, areaPixel_;
    Microsoft::WRL::ComPtr<ID3D11Buffer> presentation_;
    bool previousValid_ = false;
    unsigned width_ = 0, height_ = 0;
public:
    MapRenderer(ID3D11Device*, ID3D11DeviceContext*);
    void upload(const HistoryRecord&, const HistoryRecord*,
        const std::array<uint8_t, 24576>&, const std::array<uint8_t, 65536>&, const std::vector<float>&);
    void draw(const ViewConfig&, unsigned palette, bool persistent, unsigned outputWidth = 0, unsigned outputHeight = 0,
        float originX = 0, float originY = 0, float cell = 1, float cellY = 0);
    ID3D11ShaderResourceView* texture() const noexcept { return output_.Get(); }
    std::vector<uint32_t> readback(); // fixtures only
};
}
