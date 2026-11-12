#include "render/D3DDevice.h"
#include "render/MapRenderer.h"
#include "render/ReferenceRenderer.h"
#include "render/WaterfallRenderer.h"
#include "model/PaletteTables.h"
#include "model/MapSampling.h"
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
int main(int argc, char**) {
    try {
        D3DDevice device(nullptr, argc < 2);
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
                renderer.draw(view, palette, true, 8, 8, 0, 0, 1);
                const auto areaExact = renderer.readback();
                for(unsigned y=0;y<8;++y) for(unsigned x=0;x<8;++x)
                    for(unsigned c=0;c<3;++c) CHECK(std::abs(int((areaExact[y*8+x]>>(c*8))&255)-int((expected[y*(bits?1024:256)+x]>>(c*8))&255))<=1);
                CHECK(actual.size() == expected.size());
                for (std::size_t i = 0; i < actual.size(); ++i)
                    for (unsigned channel = 0; channel < 3; ++channel) {
                        const int a = (actual[i] >> (channel * 8)) & 255;
                        const int b = (expected[i] >> (channel * 8)) & 255;
                        CHECK(std::abs(a - b) <= 1);
                    }
            }
        }
        // Independent CPU footprint oracle: numeric means before palette lookup.
        for (bool bits : {false,true}) for (bool changes : {false,true}) {
            ViewConfig v{Measurement::Data,bits,changes,false};
            renderer.upload(*capture,previous.get(),capture->access,*persistence,{});
            renderer.draw(v,0,false,13,11,-0.25f,-0.125f,0.625f);
            const auto actual=renderer.readback();
            for(unsigned y=0;y<11;++y) for(unsigned x=0;x<13;++x) {
                const auto summary=summarizeMap(*capture,previous.get(),capture->access,{},bits,changes,false,
                    (x+0.25)/0.625,(y+0.125)/0.625,(x+1.25)/0.625,(y+1.125)/0.625);
                unsigned index=unsigned(std::floor(summary.mean*(bits?255:1)+0.50001));
                if(changes && summary.changed) index=std::max(1u,index);
                const auto expected=paletteTables[0][bits?1:0][index];
                for(unsigned c=0;c<3;++c) { if(std::abs(int((actual[y*13+x]>>(c*8))&255)-int((expected>>(c*8))&255))>1) std::fprintf(stderr,"bits %d xor %d xy %u,%u mean %.9f actual %08x expected %08x\n",bits,changes,x,y,summary.mean,actual[y*13+x],expected); CHECK(std::abs(int((actual[y*13+x]>>(c*8))&255)-int((expected>>(c*8))&255))<=1); }
            }
        }
        capture->ram.fill(0); previous->ram.fill(0); capture->access.fill(0);
        capture->access[0]=1; capture->access[8192]=2;
        renderer.upload(*capture,previous.get(),capture->access,*persistence,{});
        renderer.draw({Measurement::Activity,false,false,false},0,false,1,1,0,0,0.5f);
        CHECK(renderer.readback()[0]==paletteTables[0][3][3]);
        capture->ram[0]=1;
        renderer.upload(*capture,previous.get(),capture->access,*persistence,{});
        renderer.draw({Measurement::Data,true,true,false},0,false,1,1,0,0,0.5f);
        CHECK(renderer.readback()[0]==paletteTables[0][1][0]); // Other bit lane changed.
        // GPU timestamps are consumed only in this fixture, never in the UI.
        for(float scale : {0.75f,0.01f}) {
            Microsoft::WRL::ComPtr<ID3D11Query> disjoint,begin,end;
            D3D11_QUERY_DESC q{D3D11_QUERY_TIMESTAMP_DISJOINT,0};
            checkGpu(device.device->CreateQuery(&q,&disjoint)); q.Query=D3D11_QUERY_TIMESTAMP;
            checkGpu(device.device->CreateQuery(&q,&begin)); checkGpu(device.device->CreateQuery(&q,&end));
            device.context->Begin(disjoint.Get()); device.context->End(begin.Get());
            for(unsigned repeat=0;repeat<16;++repeat) renderer.draw({Measurement::Data,true,false,false},0,false,960,540,0,0,scale);
            device.context->End(end.Get()); device.context->End(disjoint.Get()); device.context->Flush();
            D3D11_QUERY_DATA_TIMESTAMP_DISJOINT d{}; UINT64 a=0,b=0;
            const auto deadline=GetTickCount64()+10000;
            while(device.context->GetData(disjoint.Get(),&d,sizeof(d),0)==S_FALSE && GetTickCount64()<deadline) Sleep(1);
            while(device.context->GetData(begin.Get(),&a,sizeof(a),0)==S_FALSE && GetTickCount64()<deadline) Sleep(1);
            while(device.context->GetData(end.Get(),&b,sizeof(b),0)==S_FALSE && GetTickCount64()<deadline) Sleep(1);
            CHECK(a && b && b>=a);
            if(!d.Disjoint && d.Frequency) std::printf("Area GPU %s scale %.3f: %.3f ms\n",device.software?"WARP":"hardware",scale,1000.0*double(b-a)/double(d.Frequency)/16);
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
        const auto nearestWaterfall=pixels;
        waterfall.draw(0,2,16,16);
        pixels=readTexture(device,waterfall.texture(),width,height);
        CHECK(pixels==nearestWaterfall);
        waterfall.draw(0,2,8,16);
        pixels=readTexture(device,waterfall.texture(),width,height);
        CHECK(width==8 && height==16);
        for(unsigned y=0;y<16;++y) for(unsigned x=0;x<8;++x) CHECK(pixels[y*8+x]==nearestWaterfall[y*16+x*2]);
        waterfall.draw(0,0,16,16,true);
        pixels=readTexture(device,waterfall.texture(),width,height);
        CHECK(pixels[0]==nearestWaterfall[0]); // Does not fill unavailable band.
        const float currentValue=waterfall.inspect(*history,waterfall.newestBand()-1).values[0];
        const float olderValue=waterfall.inspect(*history,waterfall.newestBand()-2).values[0];
        const unsigned filteredIndex=static_cast<unsigned>(std::floor((currentValue*2+olderValue)/3+0.50001));
        CHECK(pixels[16]==paletteTables[0][0][filteredIndex]);

        waterfall.draw(0);
        pixels=readTexture(device,waterfall.texture(),width,height);
        CHECK(pixels==nearestWaterfall); // Toggle preserves history.

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
