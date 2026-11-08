#include "D3DDevice.h"
namespace visual_spc {
using Microsoft::WRL::ComPtr;
D3DDevice::D3DDevice(HWND window, bool warp) {
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#ifndef NDEBUG
    flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_0};
    D3D_FEATURE_LEVEL obtained{};
    auto create = [&](D3D_DRIVER_TYPE type) {
        auto result = D3D11CreateDevice(nullptr, type, nullptr, flags, levels, 1,
            D3D11_SDK_VERSION, &device, &obtained, &context);
        if (result == DXGI_ERROR_SDK_COMPONENT_MISSING) {
            flags &= ~D3D11_CREATE_DEVICE_DEBUG;
            result = D3D11CreateDevice(nullptr, type, nullptr, flags, levels, 1,
                D3D11_SDK_VERSION, &device, &obtained, &context);
        }
        return result;
    };
    software = warp;
    auto result = create(warp ? D3D_DRIVER_TYPE_WARP : D3D_DRIVER_TYPE_HARDWARE);
    if (FAILED(result) && !warp) { software = true; result = create(D3D_DRIVER_TYPE_WARP); }
    checkGpu(result);
    UINT support = 0;
    checkGpu(device->CheckFormatSupport(DXGI_FORMAT_R8_UINT, &support));
    if ((support & (D3D11_FORMAT_SUPPORT_TEXTURE2D | D3D11_FORMAT_SUPPORT_SHADER_LOAD)) !=
        (D3D11_FORMAT_SUPPORT_TEXTURE2D | D3D11_FORMAT_SUPPORT_SHADER_LOAD))
        throw std::runtime_error("Required integer memory texture format is unavailable");
    ComPtr<IDXGIDevice> dxgiDevice; checkGpu(device.As(&dxgiDevice));
    ComPtr<IDXGIAdapter> adapter; checkGpu(dxgiDevice->GetAdapter(&adapter));
    DXGI_ADAPTER_DESC description{}; checkGpu(adapter->GetDesc(&description));
    adapterName = description.Description;
    if (!window) return;
    ComPtr<IDXGIFactory2> factory; checkGpu(adapter->GetParent(IID_PPV_ARGS(&factory)));
    DXGI_SWAP_CHAIN_DESC1 desc{};
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; desc.BufferCount = 2;
    desc.Scaling = DXGI_SCALING_STRETCH; desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE; desc.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;
    ComPtr<IDXGISwapChain1> swap;
    checkGpu(factory->CreateSwapChainForHwnd(device.Get(), window, &desc, nullptr, nullptr, &swap));
    checkGpu(swap.As(&swap_)); checkGpu(swap_->SetMaximumFrameLatency(1));
    latency_ = swap_->GetFrameLatencyWaitableObject();
    if (!latency_) throw std::runtime_error("Swap chain latency event is unavailable");
    checkGpu(factory->MakeWindowAssociation(window, DXGI_MWA_NO_ALT_ENTER));
    makeBackBuffer();
}
D3DDevice::~D3DDevice() {
    if (context) { context->ClearState(); context->Flush(); }
    if (latency_) CloseHandle(latency_);
}
void D3DDevice::makeBackBuffer() {
    ComPtr<ID3D11Texture2D> back;
    checkGpu(swap_->GetBuffer(0, IID_PPV_ARGS(&back)));
    checkGpu(device->CreateRenderTargetView(back.Get(), nullptr, &backBuffer_));
}
void D3DDevice::resize(unsigned width, unsigned height) {
    if (!swap_ || !width || !height) return;
    context->OMSetRenderTargets(0, nullptr, nullptr); backBuffer_.Reset();
    checkGpu(swap_->ResizeBuffers(0, width, height, DXGI_FORMAT_UNKNOWN, DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT));
    makeBackBuffer();
}
void D3DDevice::begin() {
    const float background[] = {0.02f, 0.035f, 0.06f, 1};
    auto* target = backBuffer_.Get(); context->OMSetRenderTargets(1, &target, nullptr);
    context->ClearRenderTargetView(target, background);
}
HRESULT D3DDevice::present() noexcept { return swap_ ? swap_->Present(1, 0) : S_OK; }
}
