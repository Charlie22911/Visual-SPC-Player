#include "render/D3DDevice.h"
#include "render/MapRenderer.h"
#include "render/ReferenceRenderer.h"
#include "render/WaterfallRenderer.h"
#include "model/PaletteTables.h"
#include "test_check.h"
#include <memory>
using namespace visual_spc;
std::vector<uint32_t> readTexture(D3DDevice& device, ID3D11ShaderResourceView* view, unsigned& width, unsigned& height) {
    Microsoft::WRL::ComPtr<ID3D11Resource> resource; view->GetResource(&resource);
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture; checkGpu(resource.As(&texture));
    D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc); width = desc.Width; height = desc.Height;
    desc.BindFlags = 0; desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> staging; checkGpu(device.device->CreateTexture2D(&desc, nullptr, &staging));
    device.context->CopyResource(staging.Get(), texture.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{}; checkGpu(device.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));
    std::vector<uint32_t> pixels(width * height);
    for (unsigned y = 0; y < height; ++y) std::memcpy(pixels.data() + y * width, static_cast<uint8_t*>(mapped.pData) + y * mapped.RowPitch, width * 4);
    device.context->Unmap(staging.Get(), 0); return pixels;
}
int main() {
    try {
        D3DDevice device(nullptr, true);
        MapRenderer renderer(device.device.Get(), device.context.Get());
        auto capture = std::make_unique<HistoryRecord>();
        auto previous = std::make_unique<HistoryRecord>();
        auto persistence = std::make_unique<std::array<uint8_t, 65536>>();
        for (unsigned a = 0; a < 65536; ++a) {
            capture->ram[a] = static_cast<uint8_t>(a ^ (a >> 8));
            previous->ram[a] = static_cast<uint8_t>(a * 7);
            (*persistence)[a] = static_cast<uint8_t>(a & 7);
        }
        for (unsigned i = 0; i < 24576; ++i) capture->access[i] = static_cast<uint8_t>(i * 29 + (i >> 8));
        Metrics metrics;
        for (unsigned palette = 0; palette < 5; ++palette)
        for (unsigned mode = 0; mode < 3; ++mode) for (bool bits : {false, true})
        for (bool changes : {false, true}) {
            if (changes && mode != 1) continue;
            for (bool underlay : {false, true}) {
                ViewConfig view{static_cast<Measurement>(mode), bits, changes, underlay};
                const auto entropy = metrics.entropy(capture->ram, bits);
                renderer.upload(*capture, previous.get(), capture->access, *persistence, entropy);
                renderer.draw(view, palette, true);
                const auto actual = renderer.readback();
                const auto expected = referenceMap(*capture, previous.get(), capture->access, *persistence, entropy, view, palette, true);
                CHECK(actual.size() == expected.size());
                for (std::size_t i = 0; i < actual.size(); ++i)
                    for (unsigned channel = 0; channel < 3; ++channel) {
                        const int a = (actual[i] >> (channel * 8)) & 255;
                        const int b = (expected[i] >> (channel * 8)) & 255;
                        CHECK(std::abs(a - b) <= 1);
                    }
            }
        }
        auto history = std::make_unique<History>();
        auto sample = std::make_unique<Capture>(); sample->generation = 1;
        for (unsigned i = 0; i <= 128; ++i) {
            sample->sequence = i; sample->nativeFrame = i * 2000; sample->intervalBegin = i ? (i - 1) * 2000 : 0;
            sample->ram.fill(static_cast<uint8_t>(i)); sample->access.fill(0); sample->access[(i % 3) * 8192] = 1;
            CHECK(history->accept(*sample));
        }
        history->present(1, 64000);
        WaterfallRenderer waterfall(device.device.Get(), device.context.Get());
        ViewConfig view{Measurement::Data, false, false, false, 0, 65536, 16};
        waterfall.configure(view, 16, 2);
        do { waterfall.update(*history, 2); } while (waterfall.pendingCount());
        waterfall.draw(0);
        unsigned width = 0, height = 0;
        auto pixels = readTexture(device, waterfall.texture(), width, height);
        CHECK(width == 16 && height == 16);
        CHECK(pixels[0] == 0xff221710u); // Future overlapping record is excluded.
        CHECK(pixels[16] == paletteTables[0][0][32]);
        history->present(1, 66000);
        waterfall.update(*history, 0);
        CHECK(!waterfall.inspect(*history, waterfall.newestBand()).valid);
        do { waterfall.update(*history, 2); } while (waterfall.pendingCount());
        waterfall.draw(0); pixels = readTexture(device, waterfall.texture(), width, height);
        CHECK(pixels[0] == paletteTables[0][0][33]); // Same band updates when due.
        CHECK(waterfall.inspect(*history, waterfall.newestBand()).values[0] == 33);
        history->present(1, 128000);
        do { waterfall.update(*history, 2); } while (waterfall.pendingCount());
        waterfall.draw(0); pixels = readTexture(device, waterfall.texture(), width, height);
        CHECK(pixels[16] == paletteTables[0][0][64]); // Ring slots never reveal old data.
        for (const unsigned seconds : {5u, 10u, 2u}) for (bool underlay : {false, true}) {
            view.underlay = underlay;
            waterfall.configure(view, 16, seconds);
            do { waterfall.update(*history, 2); } while (waterfall.pendingCount());
            waterfall.draw(1); pixels = readTexture(device, waterfall.texture(), width, height);
            CHECK(width == 16 && height == 16); // Time/underlay never resize the plot.
        }
        return 0;
    } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
