#include "SpectrogramRenderer.h"
#include "model/SpectrumColors.h"
#include "FullscreenVS.h"
#include "SpectrumProjectCS.h"
#include "SpectrumDisplayPS.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <stdexcept>
namespace visual_spc {
using Microsoft::WRL::ComPtr;
namespace {
using Clock=std::chrono::steady_clock;
double ms(Clock::time_point start) { return std::chrono::duration<double,std::milli>(Clock::now()-start).count(); }
struct Column { uint32_t low,high; float fraction,lowWeight=0; };
struct Project { std::array<uint32_t,4> header{}; std::array<uint32_t,12> slots{}; std::array<float,12> weights{}; };
struct TimeRow { uint32_t slot=0,count=0,next=0,valid=0; float phase=0,lowWeight=1,pad[2]{}; };
struct Constants { uint32_t width,height,capacity,sampling,difference,jobs,pad[2]{}; float floor,ceiling,pad2[2]{}; };
static_assert(sizeof(Project)==112 && sizeof(TimeRow)==32 && sizeof(Constants)==48);
}
struct SpectrogramRenderer::Impl {
    ID3D11Device* device; ID3D11DeviceContext* context;
    SpectrumView view{}; uint64_t epoch=0,serial=0; uint32_t generation=0;
    unsigned capacity=0,bins=0,nextSlot=0; uint64_t revision=1;
    struct Row { SpectrumStamp stamp{}; unsigned slot=0; uint64_t serial=0,revision=0; };
    std::deque<Row> rows;
    std::vector<Row> identities;
    std::deque<std::pair<uint64_t,unsigned>> pending;
    std::vector<float> interleaved;
    std::vector<Column> columns;
    std::vector<TimeRow> times;
    ComPtr<ID3D11Texture2D> raw,projected,output,palette;
    ComPtr<ID3D11ShaderResourceView> rawSrv,projectedSrv,outputSrv,paletteSrv,columnSrv,jobSrv,timeSrv;
    ComPtr<ID3D11UnorderedAccessView> projectedUav;
    ComPtr<ID3D11RenderTargetView> outputRtv;
    ComPtr<ID3D11Buffer> columnBuffer,jobBuffer,timeBuffer,constants;
    ComPtr<ID3D11ComputeShader> projectShader;
    ComPtr<ID3D11VertexShader> vertex;
    ComPtr<ID3D11PixelShader> displayShader;
    ComPtr<ID3D11Query> projectionFence;
    bool projectionInFlight=false;
    SpectrumRenderStats stats{};
    explicit Impl(ID3D11Device* d,ID3D11DeviceContext* c):device(d),context(c) {
        checkGpu(device->CreateComputeShader(SpectrumProjectCSBytecode,sizeof(SpectrumProjectCSBytecode),nullptr,&projectShader));
        checkGpu(device->CreateVertexShader(FullscreenVSBytecode,sizeof(FullscreenVSBytecode),nullptr,&vertex));
        checkGpu(device->CreatePixelShader(SpectrumDisplayPSBytecode,sizeof(SpectrumDisplayPSBytecode),nullptr,&displayShader));
        D3D11_BUFFER_DESC desc{}; desc.ByteWidth=sizeof(Constants); desc.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
        checkGpu(device->CreateBuffer(&desc,nullptr,&constants));
        structured(32,sizeof(Project),jobBuffer,jobSrv);
        D3D11_QUERY_DESC query{D3D11_QUERY_EVENT,0};
        checkGpu(device->CreateQuery(&query,&projectionFence));
    }
    void unbind() {
        ID3D11ShaderResourceView* empty[6]{};
        context->CSSetShaderResources(0,6,empty); context->PSSetShaderResources(0,6,empty);
        ID3D11UnorderedAccessView* uav=nullptr; context->CSSetUnorderedAccessViews(0,1,&uav,nullptr);
        context->OMSetRenderTargets(0,nullptr,nullptr);
    }
    void structured(unsigned count,unsigned stride,ComPtr<ID3D11Buffer>& buffer,ComPtr<ID3D11ShaderResourceView>& srv) {
        srv.Reset(); buffer.Reset(); D3D11_BUFFER_DESC d{};
        d.ByteWidth=count*stride; d.BindFlags=D3D11_BIND_SHADER_RESOURCE;
        d.MiscFlags=D3D11_RESOURCE_MISC_BUFFER_STRUCTURED; d.StructureByteStride=stride;
        checkGpu(device->CreateBuffer(&d,nullptr,&buffer));
        D3D11_SHADER_RESOURCE_VIEW_DESC s{}; s.ViewDimension=D3D11_SRV_DIMENSION_BUFFER;
        s.Format=DXGI_FORMAT_UNKNOWN; s.Buffer.NumElements=count;
        checkGpu(device->CreateShaderResourceView(buffer.Get(),&s,&srv));
    }
    void texture(unsigned w,unsigned h,DXGI_FORMAT format,UINT flags,ComPtr<ID3D11Texture2D>& tex,ComPtr<ID3D11ShaderResourceView>& srv) {
        tex.Reset(); srv.Reset(); UINT support=0; checkGpu(device->CheckFormatSupport(format,&support));
        if(!(support&D3D11_FORMAT_SUPPORT_TEXTURE2D) || !(support&D3D11_FORMAT_SUPPORT_SHADER_LOAD)) throw std::runtime_error("Spectrogram texture format unavailable");
        D3D11_TEXTURE2D_DESC d{}; d.Width=w; d.Height=h; d.Format=format; d.MipLevels=d.ArraySize=d.SampleDesc.Count=1; d.BindFlags=flags;
        checkGpu(device->CreateTexture2D(&d,nullptr,&tex)); checkGpu(device->CreateShaderResourceView(tex.Get(),nullptr,&srv));
    }
    double frequency(double fraction) const { return view.logarithmic?20*std::pow(800.0,fraction):16000*fraction; }
    void configure(const SpectrumView& v,uint64_t e,uint32_t g) {
        if(raw && output && projected && palette && view==v && e==epoch && g==generation) return;
        if(!v.width || !v.height || v.width>16384 || v.height>16384 || (v.fftSize!=1024 && v.fftSize!=2048 && v.fftSize!=4096) ||
            (v.hopSize!=64 && v.hopSize!=128 && v.hopSize!=256 && v.hopSize!=512) || v.sampling>2 || v.temporalMs>200 || v.seconds>10 || !v.seconds)
            throw std::runtime_error("Unsupported spectrogram configuration");
        const unsigned cap=static_cast<unsigned>(std::ceil(10.7*32000/v.hopSize))+16, binCount=v.fftSize/2+1;
        const size_t bytes=size_t(cap)*binCount*8+size_t(cap)*v.width*4+size_t(v.width)*v.height*4+8*1024*1024;
        if(bytes>384ull*1024*1024) throw std::runtime_error("Spectrogram configuration exceeds the 384 MiB graphics budget");
        const bool reset=!raw || e!=epoch || g!=generation || v.fftSize!=view.fftSize || v.hopSize!=view.hopSize;
        const bool horizontal=reset || !projected || v.width!=view.width || v.sampling!=view.sampling || v.logarithmic!=view.logarithmic ||
            v.difference!=view.difference || v.temporal!=view.temporal || v.temporalMs!=view.temporalMs;
        const bool outputChanged=!output || v.width!=view.width || v.height!=view.height;
        const bool paletteChanged=!palette || v.palette!=view.palette || v.difference!=view.difference;
        unbind();
        if(reset) {
            rawSrv.Reset(); raw.Reset(); projectedUav.Reset(); projectedSrv.Reset(); projected.Reset();
            capacity=cap; bins=binCount; rows.clear(); pending.clear(); identities.assign(capacity,{}); nextSlot=0;
            texture(bins,capacity,DXGI_FORMAT_R32G32_FLOAT,D3D11_BIND_SHADER_RESOURCE,raw,rawSrv);
            interleaved.resize(bins*2); epoch=e; generation=g;
        }
        if(horizontal) {
            projectedUav.Reset(); projectedSrv.Reset(); projected.Reset();
            texture(v.width,capacity,DXGI_FORMAT_R32_FLOAT,D3D11_BIND_UNORDERED_ACCESS|D3D11_BIND_SHADER_RESOURCE,projected,projectedSrv);
            checkGpu(device->CreateUnorderedAccessView(projected.Get(),nullptr,&projectedUav));
            ++revision; pending.clear();
            for(auto it=rows.rbegin();it!=rows.rend();++it) pending.emplace_back(it->serial,it->slot);
        }
        view=v;
        if(horizontal) {
            columns.resize(v.width);
            for(unsigned x=0;x<v.width;++x) {
                auto& col=columns[x]; const unsigned last=bins-1;
                col.low=std::min(last,static_cast<unsigned>(frequency(double(x)/v.width)*v.fftSize/32000));
                col.high=std::clamp(static_cast<unsigned>(std::ceil(frequency(double(x+1)/v.width)*v.fftSize/32000)),col.low+1,bins);
                if(v.sampling==1) { const double b=frequency((x+0.5)/v.width)*v.fftSize/32000;
                    col.low=std::min(last,static_cast<unsigned>(std::floor(b))); col.high=std::min(bins,col.low+2);
                    const double fraction=b-std::floor(b); col.fraction=static_cast<float>(fraction); col.lowWeight=static_cast<float>(1-fraction);
                } else if(v.sampling!=2) { col.low=std::min(last,static_cast<unsigned>(frequency((x+0.5)/v.width)*v.fftSize/32000+0.5)); col.high=col.low+1; }
            }
            structured(v.width,sizeof(Column),columnBuffer,columnSrv);
            context->UpdateSubresource(columnBuffer.Get(),0,nullptr,columns.data(),0,0);
        }
        if(outputChanged) {
            outputRtv.Reset(); outputSrv.Reset(); output.Reset();
            texture(v.width,v.height,DXGI_FORMAT_R8G8B8A8_UNORM,D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE,output,outputSrv);
            checkGpu(device->CreateRenderTargetView(output.Get(),nullptr,&outputRtv));
            times.resize(v.height); structured(v.height,sizeof(TimeRow),timeBuffer,timeSrv);
        }
        if(paletteChanged) {
            if(!palette) texture(256,1,DXGI_FORMAT_R8G8B8A8_UNORM,D3D11_BIND_SHADER_RESOURCE,palette,paletteSrv);
            std::array<uint32_t,256> colors{};
            for(unsigned i=0;i<256;++i) colors[i]=spectrumColor(i,v.difference?2:v.palette);
            context->UpdateSubresource(palette.Get(),0,nullptr,colors.data(),256*4,0);
        }
        stats.bytes=bytes;
    }
    bool upload(const SpectrumResult& result,double audible) {
        const auto& s=result.stamp;
        if(s.analysisEpoch!=epoch || s.generation!=generation || s.bins!=bins || s.endFrame>audible+16000) { ++stats.dropped; return false; }
        if(!rows.empty() && s.endFrame<=rows.back().stamp.endFrame) { ++stats.dropped; return false; }
        const auto start=Clock::now(); unbind();
        for(unsigned i=0;i<bins;++i) { interleaved[i*2]=result.power[i]; interleaved[i*2+1]=result.difference[i]; }
        const unsigned slot=nextSlot; nextSlot=(nextSlot+1)%capacity;
        if(rows.size()==capacity) rows.pop_front();
        Row row{s,slot,++serial,0}; identities[slot]=row; rows.push_back(row);
        D3D11_BOX box{0,slot,0,bins,slot+1,1};
        context->UpdateSubresource(raw.Get(),0,&box,interleaved.data(),bins*8,0);
        pending.emplace_front(row.serial,slot);
        while(pending.size()>capacity*2) pending.pop_back();
        ++stats.uploaded; stats.uploadMs=ms(start); return true;
    }
    bool contiguous(const Row& a,const Row& b) const {
        return a.stamp.segment==b.stamp.segment && b.stamp.rowSequence==a.stamp.rowSequence+1 && b.stamp.endFrame==a.stamp.endFrame+view.hopSize;
    }
    Constants config(unsigned jobs=0) const { return {view.width,view.height,capacity,view.sampling,view.difference?1u:0u,jobs,{},view.floorDb,view.ceilingDb,{}}; }
    void update(double budget) {
        if(!raw || pending.empty()) return;
        // Large explicit budgets are reserved for offline parity/benchmark runs.
        // Live updates never queue another projection batch behind an unfinished one.
        const bool live=budget<10;
        if(projectionInFlight) {
            BOOL ready=FALSE;
            const auto hr=context->GetData(projectionFence.Get(),&ready,sizeof(ready),D3D11_ASYNC_GETDATA_DONOTFLUSH);
            checkGpu(hr);
            if(hr==S_FALSE || !ready) {
                // Offline callers may have no swap chain/Present to flush commands.
                if(!live) { context->Flush(); Sleep(1); }
                return;
            }
            projectionInFlight=false;
        }
        const auto start=Clock::now(); unbind();
        unsigned submitted=0;
        auto* cb=constants.Get(); context->CSSetConstantBuffers(0,1,&cb); context->CSSetShader(projectShader.Get(),nullptr,0);
        ID3D11ShaderResourceView* srvs[]{rawSrv.Get(),columnSrv.Get(),jobSrv.Get()}; context->CSSetShaderResources(0,3,srvs);
        auto* uav=projectedUav.Get(); context->CSSetUnorderedAccessViews(0,1,&uav,nullptr);
        do {
            std::array<Project,32> jobs{}; std::array<unsigned,32> slots{}; unsigned count=0;
            while(!pending.empty() && count<jobs.size()) {
                const auto [id,slot]=pending.front(); pending.pop_front();
                if(identities[slot].serial!=id || identities[slot].revision==revision) continue;
                auto it=std::lower_bound(rows.begin(),rows.end(),id,[](const Row& r,uint64_t n){return r.serial<n;});
                if(it==rows.end() || it->serial!=id) continue;
                auto& job=jobs[count]; job.header[0]=slot;
                const unsigned radius=view.temporal?view.temporalMs*32/view.hopSize:0, step=std::max(1u,(radius+7)/8);
                const size_t index=static_cast<size_t>(it-rows.begin());
                unsigned contiguousAge=0;
                while(contiguousAge<radius && contiguousAge<index && contiguous(rows[index-contiguousAge-1],rows[index-contiguousAge])) ++contiguousAge;
                double norm=0;
                for(unsigned age=0;age<=contiguousAge;age+=step) {
                    const auto tap=job.header[1]++; job.slots[tap]=rows[index-age].slot;
                    const float weight=view.temporal?static_cast<float>(std::exp(-double(age*view.hopSize)/(std::max(1u,view.temporalMs)*32.0))):1;
                    job.weights[tap]=weight; norm+=weight;
                }
                for(unsigned i=0;i<job.header[1];++i) job.weights[i]/=static_cast<float>(norm);
                slots[count++]=slot;
            }
            if(count) {
                D3D11_BOX box{0,0,0,count*static_cast<UINT>(sizeof(Project)),1,1};
                context->UpdateSubresource(jobBuffer.Get(),0,&box,jobs.data(),0,0);
                const auto c=config(count); context->UpdateSubresource(constants.Get(),0,nullptr,&c,0,0);
                context->Dispatch((view.width+31)/32,count,1);
                for(unsigned i=0;i<count;++i) identities[slots[i]].revision=revision;
                stats.projected+=count;
                submitted+=count;
            }
        } while(!pending.empty() && ms(start)<budget && (!live || submitted<64));
        if(live && submitted) { context->End(projectionFence.Get()); projectionInFlight=true; }
        unbind(); stats.projectionMs=ms(start);
    }
    void draw(double audible) {
        if(!output) return;
        const auto start=Clock::now(); unbind();
        for(unsigned y=0;y<view.height;++y) {
            auto& plan=times[y]; plan={};
            const double end=audible-double(y)*view.seconds*32000/view.height,begin=end-double(view.seconds)*32000/view.height;
            auto upper=std::upper_bound(rows.begin(),rows.end(),end,[](double f,const Row& r){return f<r.stamp.endFrame;});
            if(upper==rows.begin()) continue;
            auto latest=std::prev(upper);
            if(end-latest->stamp.endFrame>view.hopSize*2 || identities[latest->slot].revision!=revision) continue;
            auto first=latest;
            if(view.sampling==2) while(first!=rows.begin() && std::prev(first)->stamp.endFrame>=begin && contiguous(*std::prev(first),*first)) --first;
            bool valid=true;
            for(auto it=first;it!=upper;++it) if(identities[it->slot].revision!=revision) { valid=false; break; }
            if(!valid) continue;
            plan={first->slot,static_cast<uint32_t>(upper-first),0,1};
            if(view.sampling==1 && upper!=rows.end() && upper->stamp.endFrame<=audible && contiguous(*latest,*upper) && identities[upper->slot].revision==revision) {
                const double phase=std::clamp((end-latest->stamp.endFrame)/view.hopSize,0.0,1.0);
                plan.next=upper->slot; plan.phase=static_cast<float>(phase); plan.lowWeight=static_cast<float>(1-phase);
            }
        }
        context->UpdateSubresource(timeBuffer.Get(),0,nullptr,times.data(),0,0);
        const auto c=config(); context->UpdateSubresource(constants.Get(),0,nullptr,&c,0,0);
        auto* target=outputRtv.Get(); context->OMSetRenderTargets(1,&target,nullptr);
        D3D11_VIEWPORT viewport{0,0,static_cast<float>(view.width),static_cast<float>(view.height),0,1}; context->RSSetViewports(1,&viewport);
        context->RSSetState(nullptr); context->OMSetBlendState(nullptr,nullptr,0xffffffff); context->OMSetDepthStencilState(nullptr,0);
        context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vertex.Get(),nullptr,0); context->GSSetShader(nullptr,nullptr,0); context->PSSetShader(displayShader.Get(),nullptr,0);
        auto* cb=constants.Get(); context->PSSetConstantBuffers(0,1,&cb);
        ID3D11ShaderResourceView* srvs[]{projectedSrv.Get(),timeSrv.Get(),paletteSrv.Get()}; context->PSSetShaderResources(3,3,srvs);
        context->Draw(3,0); unbind(); ++stats.draws; stats.drawMs=ms(start);
    }
};
SpectrogramRenderer::SpectrogramRenderer(ID3D11Device* d,ID3D11DeviceContext* c):impl_(std::make_unique<Impl>(d,c)) {}
SpectrogramRenderer::~SpectrogramRenderer()=default;
void SpectrogramRenderer::configure(const SpectrumView& v,uint64_t e,uint32_t g) { impl_->configure(v,e,g); }
bool SpectrogramRenderer::upload(const SpectrumResult& r,double a) { return impl_->upload(r,a); }
void SpectrogramRenderer::update(double b) { impl_->update(b); }
void SpectrogramRenderer::draw(double a) { impl_->draw(a); }
ID3D11ShaderResourceView* SpectrogramRenderer::texture() const { return impl_->outputSrv.Get(); }
ID3D11ShaderResourceView* SpectrogramRenderer::projectedTexture() const { return impl_->projectedSrv.Get(); }
SpectrumRenderStats SpectrogramRenderer::stats() const { auto s=impl_->stats; s.pending=impl_->pending.size(); return s; }
}
