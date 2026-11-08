#pragma once
#include <Windows.h>
#include <d3d11.h>
#include <dxgi1_3.h>
#include <wrl/client.h>
#include <stdexcept>
#include <string>
namespace visual_spc {
inline void checkGpu(HRESULT hr) {
    if (FAILED(hr)) throw std::runtime_error("Direct3D failure: " + std::to_string(static_cast<unsigned long>(hr)));
}
class D3DDevice {
    Microsoft::WRL::ComPtr<IDXGISwapChain2> swap_;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> backBuffer_;
    HANDLE latency_ = nullptr;
    void makeBackBuffer();
public:
    Microsoft::WRL::ComPtr<ID3D11Device> device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
    bool software = false;
    std::wstring adapterName;
    explicit D3DDevice(HWND window, bool warp = false);
    ~D3DDevice();
    HANDLE latencyHandle() const noexcept { return latency_; }
    void resize(unsigned width, unsigned height);
    void begin();
    HRESULT present() noexcept;
};
}
