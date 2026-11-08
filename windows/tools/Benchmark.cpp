#include "render/D3DDevice.h"
#include "render/MapRenderer.h"
#include "render/WaterfallRenderer.h"
#include "render/ReferenceRenderer.h"
#include "platform/Files.h"
#include "../vendor/json/json.hpp"
#include "FullscreenVS.h"
#include "BlitPS.h"
#include <chrono>
#include <numeric>
#include <iostream>
#include <fstream>
using namespace visual_spc;
using Microsoft::WRL::ComPtr;
namespace {
using Clock = std::chrono::steady_clock;
double elapsed(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); }
double percentile(std::vector<double> values, double p) {
    std::sort(values.begin(), values.end());
    return values.empty() ? 0 : values[static_cast<size_t>((values.size() - 1) * p)];
}
struct Timing { ComPtr<ID3D11Query> disjoint, begin, end; };
}
int main(int argc, char** argv) {
    try {
        D3DDevice device(nullptr);
        MapRenderer map(device.device.Get(), device.context.Get());
        auto current = std::make_unique<HistoryRecord>(), previous = std::make_unique<HistoryRecord>();
        auto persistence = std::make_unique<std::array<uint8_t, 65536>>();
        for (unsigned a = 0; a < 65536; ++a) {
            current->ram[a] = static_cast<uint8_t>(a * 37 + (a >> 8)); previous->ram[a] = static_cast<uint8_t>(a * 19);
        }
        for (unsigned a = 0; a < 24576; ++a) current->access[a] = static_cast<uint8_t>(a * 29 + (a >> 8));
        const ViewConfig view{Measurement::Activity, true, false, true};
        std::vector<uint32_t> reference;
        std::vector<double> cpu;
        for (unsigned frame = 0; frame < 100; ++frame) {
            const auto start = Clock::now();
            referenceMapInto(*current, previous.get(), current->access, *persistence, {}, view, 0, false, reference);
            if (frame >= 10) cpu.push_back(elapsed(start));
        }
        nlohmann::json report{{"adapter", utf8(device.adapterName)}, {"software", device.software},
            {"cpuReferenceMapMsMedian", percentile(cpu, 0.5)}, {"cpuReferenceMapMsP95", percentile(cpu, 0.95)}};
        ComPtr<ID3D11VertexShader> vertex; ComPtr<ID3D11PixelShader> blit;
        checkGpu(device.device->CreateVertexShader(FullscreenVSBytecode, sizeof(FullscreenVSBytecode), nullptr, &vertex));
        checkGpu(device.device->CreatePixelShader(BlitPSBytecode, sizeof(BlitPSBytecode), nullptr, &blit));
        ComPtr<ID3D11Buffer> constants;
        D3D11_BUFFER_DESC buffer{}; buffer.ByteWidth = sizeof(ShaderConfig); buffer.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        checkGpu(device.device->CreateBuffer(&buffer, nullptr, &constants));
        for (const unsigned width : {1920u, 3840u}) {
            const unsigned height = width * 9 / 16;
            ComPtr<ID3D11Texture2D> target; ComPtr<ID3D11RenderTargetView> targetView;
            D3D11_TEXTURE2D_DESC desc{}; desc.Width = width; desc.Height = height;
            desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1;
            desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.BindFlags = D3D11_BIND_RENDER_TARGET;
            checkGpu(device.device->CreateTexture2D(&desc, nullptr, &target));
            checkGpu(device.device->CreateRenderTargetView(target.Get(), nullptr, &targetView));
            std::array<Timing, 16> timings{};
            for (auto& timing : timings) {
                D3D11_QUERY_DESC query{D3D11_QUERY_TIMESTAMP_DISJOINT, 0}; checkGpu(device.device->CreateQuery(&query, &timing.disjoint));
                query.Query = D3D11_QUERY_TIMESTAMP;
                checkGpu(device.device->CreateQuery(&query, &timing.begin)); checkGpu(device.device->CreateQuery(&query, &timing.end));
            }
            cpu.clear();
            for (unsigned frame = 0; frame < 80; ++frame) {
                auto* context = device.context.Get();
                ID3D11ShaderResourceView* empty = nullptr; context->PSSetShaderResources(8, 1, &empty);
                Timing* timing = frame >= 64 ? &timings[frame - 64] : nullptr;
                if (timing) { context->Begin(timing->disjoint.Get()); context->End(timing->begin.Get()); }
                const auto start = Clock::now();
                map.upload(*current, previous.get(), current->access, *persistence, {}); map.draw(view, 0, false);
                D3D11_VIEWPORT viewport{0, 0, static_cast<float>(width), static_cast<float>(height), 0, 1};
                context->RSSetViewports(1, &viewport);
                auto* renderTarget = targetView.Get(); context->OMSetRenderTargets(1, &renderTarget, nullptr);
                auto* image = map.texture(); context->PSSetShaderResources(8, 1, &image);
                const ShaderConfig config{0, 1, 0, 0, 0, 0, 0, height, 0, width, 0, 0};
                context->UpdateSubresource(constants.Get(), 0, nullptr, &config, 0, 0);
                auto* cb = constants.Get(); context->PSSetConstantBuffers(0, 1, &cb);
                context->VSSetShader(vertex.Get(), nullptr, 0); context->PSSetShader(blit.Get(), nullptr, 0); context->Draw(3, 0);
                context->PSSetShaderResources(8, 1, &empty); context->OMSetRenderTargets(0, nullptr, nullptr);
                if (frame >= 16) cpu.push_back(elapsed(start));
                if (timing) { context->End(timing->end.Get()); context->End(timing->disjoint.Get()); }
            }
            device.context->Flush();
            std::vector<double> gpu; const auto deadline = Clock::now() + std::chrono::seconds(10);
            for (auto& timing : timings) {
                D3D11_QUERY_DATA_TIMESTAMP_DISJOINT disjoint{};
                HRESULT ready = S_FALSE;
                while ((ready = device.context->GetData(timing.disjoint.Get(), &disjoint, sizeof(disjoint), 0)) == S_FALSE) {
                    if (Clock::now() > deadline) throw std::runtime_error("GPU timing query timeout"); Sleep(1);
                }
                checkGpu(ready);
                UINT64 begin = 0, end = 0;
                checkGpu(device.context->GetData(timing.begin.Get(), &begin, sizeof(begin), 0));
                checkGpu(device.context->GetData(timing.end.Get(), &end, sizeof(end), 0));
                if (!disjoint.Disjoint && disjoint.Frequency && end > begin) gpu.push_back(static_cast<double>(end - begin) * 1000 / disjoint.Frequency);
            }
            report["resolutions"].push_back({{"width", width}, {"height", height}, {"gpuSubmitCpuMsMedian", percentile(cpu, 0.5)},
                {"gpuSubmitCpuMsP95", percentile(cpu, 0.95)}, {"gpuTimingValidSamples", gpu.size()},
                {"gpuExecutionMsMedian", gpu.empty() ? nlohmann::json(nullptr) : nlohmann::json(percentile(gpu, 0.5))}});
        }
        auto history = std::make_unique<History>(); auto capture = std::make_unique<Capture>(); capture->generation = 1;
        for (unsigned i = 0; i <= 2400; ++i) {
            capture->sequence = i; capture->nativeFrame = i * 32000ull / 240; capture->intervalBegin = i ? (i - 1) * 32000ull / 240 : 0;
            for (unsigned a = 0; a < 65536; ++a) capture->ram[a] = static_cast<uint8_t>(a * 37 + i);
            capture->access[0] = static_cast<uint8_t>(i);
            if (!history->accept(*capture)) throw std::runtime_error("History retention rejected an input");
        }
        history->present(1, 320000);
        report["retainedSeconds"] = history->retainedSeconds(); report["historyBytes"] = history->payloadBytes();
        for (const auto measurement : {Measurement::Activity, Measurement::Data, Measurement::Entropy}) {
            WaterfallRenderer waterfall(device.device.Get(), device.context.Get());
            ViewConfig config{measurement, true, measurement == Measurement::Data, true, 0, 65536, 240};
            waterfall.configure(config, 720, 10);
            std::vector<double> batches; const auto total = Clock::now();
            do { const auto start = Clock::now(); waterfall.update(*history, 2); batches.push_back(elapsed(start)); }
            while (waterfall.pendingCount());
            waterfall.draw(0);
            report["waterfall"].push_back({{"mode", static_cast<int>(measurement)}, {"totalRebuildMs", elapsed(total)},
                {"batchP95Ms", percentile(batches, 0.95)}, {"batchMaxMs", *std::max_element(batches.begin(), batches.end())}});
        }
        const auto output = report.dump(2); std::cout << output << "\n";
        if (argc > 1) { std::ofstream file(argv[1]); file << output << "\n"; }
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << "\n"; return 1; }
}
