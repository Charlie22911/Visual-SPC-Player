#include "MapRenderer.h"
#include "model/PaletteTables.h"
#include "FullscreenVS.h"
#include "MapPS.h"
#include <cstring>
#include <algorithm>
namespace visual_spc {
using Microsoft::WRL::ComPtr;
MapRenderer::MapRenderer(ID3D11Device* device, ID3D11DeviceContext* context) : device_(device), context_(context) {
    auto ram = [&](ComPtr<ID3D11Texture2D>& texture, ComPtr<ID3D11ShaderResourceView>& view) {
        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = desc.Height = 256; desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1;
        desc.Format = DXGI_FORMAT_R8_UINT; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        checkGpu(device->CreateTexture2D(&desc, nullptr, &texture));
        checkGpu(device->CreateShaderResourceView(texture.Get(), nullptr, &view));
    };
    ram(current_, inputs_[0]); ram(previous_, inputs_[2]); ram(persistence_, inputs_[5]);
    auto buffer = [&](UINT bytes, DXGI_FORMAT format, ComPtr<ID3D11Buffer>& resource, ComPtr<ID3D11ShaderResourceView>& view) {
        D3D11_BUFFER_DESC desc{}; desc.ByteWidth = bytes; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        checkGpu(device->CreateBuffer(&desc, nullptr, &resource));
        D3D11_SHADER_RESOURCE_VIEW_DESC srv{}; srv.Format = format;
        srv.ViewDimension = D3D11_SRV_DIMENSION_BUFFER; srv.Buffer.NumElements = bytes / 4;
        checkGpu(device->CreateShaderResourceView(resource.Get(), &srv, &view));
    };
    buffer(24576, DXGI_FORMAT_R32_UINT, access_, inputs_[1]);
    buffer(2048 * 4, DXGI_FORMAT_R32_FLOAT, entropy_, inputs_[3]);
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = 256; desc.Height = 20; desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA initial{paletteTables, 256 * 4, 0};
    checkGpu(device->CreateTexture2D(&desc, &initial, &palette_));
    checkGpu(device->CreateShaderResourceView(palette_.Get(), nullptr, &inputs_[4]));
    D3D11_BUFFER_DESC cb{}; cb.ByteWidth = sizeof(ShaderConfig); cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    checkGpu(device->CreateBuffer(&cb, nullptr, &constants_));
    checkGpu(device->CreateVertexShader(FullscreenVSBytecode, sizeof(FullscreenVSBytecode), nullptr, &vertex_));
    checkGpu(device->CreatePixelShader(MapPSBytecode, sizeof(MapPSBytecode), nullptr, &pixel_));
}
void MapRenderer::upload(const HistoryRecord& current, const HistoryRecord* previous,
    const std::array<uint8_t, 24576>& access, const std::array<uint8_t, 65536>& persistence,
    const std::vector<float>& entropy) {
    ID3D11ShaderResourceView* empty[8]{}; context_->PSSetShaderResources(0, 8, empty);
    context_->UpdateSubresource(current_.Get(), 0, nullptr, current.ram.data(), 256, 0);
    context_->UpdateSubresource(previous_.Get(), 0, nullptr, previous ? previous->ram.data() : current.ram.data(), 256, 0);
    context_->UpdateSubresource(persistence_.Get(), 0, nullptr, persistence.data(), 256, 0);
    context_->UpdateSubresource(access_.Get(), 0, nullptr, access.data(), 0, 0);
    std::array<float, 2048> values{};
    if (entropy.size() > values.size()) throw std::runtime_error("Invalid entropy payload");
    std::copy(entropy.begin(), entropy.end(), values.begin());
    context_->UpdateSubresource(entropy_.Get(), 0, nullptr, values.data(), 0, 0);
    previousValid_ = previous != nullptr;
}
void MapRenderer::draw(const ViewConfig& view, unsigned palette, bool persistent) {
    const unsigned width = view.bits ? 1024 : 256, height = view.bits ? 512 : 256;
    if (width != width_ || height != height_) {
        context_->OMSetRenderTargets(0, nullptr, nullptr);
        output_.Reset(); targetView_.Reset(); target_.Reset();
        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = width; desc.Height = height; desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1;
        desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        checkGpu(device_->CreateTexture2D(&desc, nullptr, &target_));
        checkGpu(device_->CreateRenderTargetView(target_.Get(), nullptr, &targetView_));
        checkGpu(device_->CreateShaderResourceView(target_.Get(), nullptr, &output_));
        width_ = width; height_ = height;
    }
    const ShaderConfig config{static_cast<uint32_t>(view.measurement), view.bits, view.changesOnly, view.underlay,
        std::min(palette, 4u), previousValid_, persistent, 0, 0, width, 0, 0};
    context_->UpdateSubresource(constants_.Get(), 0, nullptr, &config, 0, 0);
    D3D11_VIEWPORT viewport{0, 0, static_cast<float>(width), static_cast<float>(height), 0, 1};
    context_->RSSetViewports(1, &viewport); context_->RSSetState(nullptr);
    auto* target = targetView_.Get(); context_->OMSetRenderTargets(1, &target, nullptr);
    context_->OMSetBlendState(nullptr, nullptr, 0xffffffff); context_->OMSetDepthStencilState(nullptr, 0);
    context_->IASetInputLayout(nullptr); context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context_->VSSetShader(vertex_.Get(), nullptr, 0); context_->PSSetShader(pixel_.Get(), nullptr, 0);
    context_->GSSetShader(nullptr, nullptr, 0);
    auto* cb = constants_.Get(); context_->PSSetConstantBuffers(0, 1, &cb);
    ID3D11ShaderResourceView* inputs[6]{};
    for (unsigned i = 0; i < 6; ++i) inputs[i] = inputs_[i].Get();
    context_->PSSetShaderResources(0, 6, inputs); context_->Draw(3, 0);
    ID3D11ShaderResourceView* empty[6]{}; context_->PSSetShaderResources(0, 6, empty);
    context_->OMSetRenderTargets(0, nullptr, nullptr);
}
std::vector<uint32_t> MapRenderer::readback() {
    if (!target_) return {};
    D3D11_TEXTURE2D_DESC desc{}; target_->GetDesc(&desc);
    desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging; checkGpu(device_->CreateTexture2D(&desc, nullptr, &staging));
    context_->CopyResource(staging.Get(), target_.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{}; checkGpu(context_->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));
    std::vector<uint32_t> result(width_ * height_);
    for (unsigned y = 0; y < height_; ++y) std::memcpy(result.data() + y * width_,
        static_cast<const uint8_t*>(mapped.pData) + y * mapped.RowPitch, width_ * 4);
    context_->Unmap(staging.Get(), 0);
    return result;
}
}
