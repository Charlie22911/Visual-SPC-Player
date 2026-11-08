#include "WaterfallRenderer.h"
#include "model/PaletteTables.h"
#include "FullscreenVS.h"
#include "WaterfallPS.h"
#include <algorithm>
#include <cmath>
#include <limits>
namespace visual_spc {
WaterfallRenderer::WaterfallRenderer(ID3D11Device* device, ID3D11DeviceContext* context)
    : device_(device), context_(context) {
    checkGpu(device->CreateVertexShader(FullscreenVSBytecode, sizeof(FullscreenVSBytecode), nullptr, &vertex_));
    checkGpu(device->CreatePixelShader(WaterfallPSBytecode, sizeof(WaterfallPSBytecode), nullptr, &pixel_));
    D3D11_BUFFER_DESC cb{}; cb.ByteWidth = sizeof(ShaderConfig); cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    checkGpu(device->CreateBuffer(&cb, nullptr, &constants_));
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = 256; desc.Height = 20; desc.ArraySize = desc.MipLevels = desc.SampleDesc.Count = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA initial{paletteTables, 1024, 0};
    checkGpu(device->CreateTexture2D(&desc, &initial, &palette_));
    checkGpu(device->CreateShaderResourceView(palette_.Get(), nullptr, &paletteView_));
}
void WaterfallRenderer::invalidateAll() {
    active_.reset();
    built_.assign(height_, {}); inspected_ = {}; inspectedBand_ = -1; inspectedEndpoint_ = 0;
    pending_.clear();
    for (int64_t band = newestBand_; band >= 0 && band > newestBand_ - height_; --band) pending_.insert(band);
    selectedId_ = 0;
}
void WaterfallRenderer::configure(const ViewConfig& config, unsigned height, unsigned seconds) {
    if (!height || height > 8192 || (seconds != 2 && seconds != 5 && seconds != 10)) throw std::runtime_error("Invalid waterfall size");
    bucketRange(config.start, config.span, config.columns, 0);
    const unsigned width = config.columns * (config.bits ? 8 : 1);
    const bool geometry = width != width_ || height != height_;
    const bool changed = geometry || seconds != seconds_ || config.start != config_.start ||
        config.span != config_.span || config.columns != config_.columns || config.bits != config_.bits ||
        config.measurement != config_.measurement || config.changesOnly != config_.changesOnly || config.underlay != config_.underlay;
    config_ = config; seconds_ = seconds;
    if (geometry) {
        context_->OMSetRenderTargets(0, nullptr, nullptr);
        ID3D11ShaderResourceView* empty[8]{}; context_->PSSetShaderResources(0, 8, empty);
        rowsView_.Reset(); flagsView_.Reset(); outputView_.Reset(); target_.Reset();
        rows_.Reset(); flags_.Reset(); outputTexture_.Reset();
        width_ = width; height_ = height;
        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = width; desc.Height = height; desc.ArraySize = desc.MipLevels = desc.SampleDesc.Count = 1;
        desc.Format = DXGI_FORMAT_R32G32_FLOAT; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        checkGpu(device_->CreateTexture2D(&desc, nullptr, &rows_));
        checkGpu(device_->CreateShaderResourceView(rows_.Get(), nullptr, &rowsView_));
        desc.Format = DXGI_FORMAT_R8_UINT;
        std::vector<uint8_t> zero(static_cast<size_t>(width) * height);
        D3D11_SUBRESOURCE_DATA initial{zero.data(), width, 0};
        checkGpu(device_->CreateTexture2D(&desc, &initial, &flags_));
        checkGpu(device_->CreateShaderResourceView(flags_.Get(), nullptr, &flagsView_));
        desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.BindFlags |= D3D11_BIND_RENDER_TARGET;
        checkGpu(device_->CreateTexture2D(&desc, nullptr, &outputTexture_));
        checkGpu(device_->CreateShaderResourceView(outputTexture_.Get(), nullptr, &outputView_));
        checkGpu(device_->CreateRenderTargetView(outputTexture_.Get(), nullptr, &target_));
        slots_.assign(height, std::numeric_limits<int64_t>::min());
        rowData_.resize(width * 2); rowFlags_.resize(width);
    }
    if (changed) {
        // Invalidate all rows immediately; no stale old-mode pixels while the
        // numeric rebuild is sliced over successive frames.
        std::fill(slots_.begin(), slots_.end(), std::numeric_limits<int64_t>::min());
        std::vector<uint8_t> zero(static_cast<size_t>(width_) * height_);
        context_->UpdateSubresource(flags_.Get(), 0, nullptr, zero.data(), width_, 0);
        invalidateAll();
    }
}
void WaterfallRenderer::update(const History& history, double budget) {
    const auto* latest = history.selected();
    if (!latest || !width_) return;
    const auto nextBand = static_cast<int64_t>(std::floor(latest->nativeFrame / framesPerBand()));
    if (latest->generation != generation_ || nextBand < newestBand_ || nextBand - newestBand_ >= height_) {
        metrics_.clearCache();
        generation_ = latest->generation; newestBand_ = nextBand; invalidateAll();
        std::fill(slots_.begin(), slots_.end(), std::numeric_limits<int64_t>::min());
        std::vector<uint8_t> zero(static_cast<size_t>(width_) * height_);
        context_->UpdateSubresource(flags_.Get(), 0, nullptr, zero.data(), width_, 0);
    } else if (latest->id != selectedId_) {
        const auto from = selectedId_ ? static_cast<int64_t>(std::floor(selectedFrame_ / framesPerBand())) : nextBand - height_ + 1;
        newestBand_ = nextBand;
        for (auto band = std::max<int64_t>({0, from, nextBand - height_ + 1}); band <= nextBand; ++band) pending_.insert(band);
    }
    selectedId_ = latest->id; selectedFrame_ = latest->nativeFrame;
    for (auto i = pending_.begin(); i != pending_.end();) {
        if (*i > newestBand_ || *i <= newestBand_ - height_) i = pending_.erase(i); else ++i;
    }
    if (active_ && !pending_.contains(activeBand_)) active_.reset();
    // A reused physical slot must never expose an older band's values while
    // waiting for its new numeric reduction.
    std::fill(rowFlags_.begin(), rowFlags_.end(), 0);
    for (const auto band : pending_) {
        const auto slot = static_cast<unsigned>(band % height_);
        if (slots_[slot] == band) continue;
        if (slots_[slot] != std::numeric_limits<int64_t>::min()) {
            D3D11_BOX box{0, slot, 0, width_, slot + 1, 1};
            context_->UpdateSubresource(flags_.Get(), 0, &box, rowFlags_.data(), width_, 0);
        }
        slots_[slot] = band;
    }
    const auto started = std::chrono::steady_clock::now();
    const auto deadline = started + std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::duration<double, std::milli>(budget));
    while (!pending_.empty()) {
        if (!active_) {
            activeBand_ = *pending_.begin();
            active_ = std::make_unique<BandJob>(history, config_, activeBand_ * framesPerBand(), (activeBand_ + 1) * framesPerBand());
        }
        const auto band = activeBand_;
        const auto slot = static_cast<unsigned>(band % height_);
        if (!active_->step(history, metrics_, deadline)) break;
        const auto& row = active_->result();
        const unsigned lanes = config_.bits ? 8 : 1;
        for (unsigned x = 0; x < config_.columns; ++x) for (unsigned lane = 0; lane < lanes; ++lane) {
            const auto destination = x * lanes + lane, source = lane * config_.columns + x;
            rowData_[2 * destination] = row.valid ? row.values[source] : 0;
            rowData_[2 * destination + 1] = row.valid && !row.background.empty() ? row.background[source] : 0;
            rowFlags_[destination] = static_cast<uint8_t>(row.valid ? 1 | (!row.anyChange.empty() && row.anyChange[source] ? 2 : 0) : 0);
        }
        D3D11_BOX box{0, slot, 0, width_, slot + 1, 1};
        context_->UpdateSubresource(rows_.Get(), 0, &box, rowData_.data(), width_ * 8, 0);
        context_->UpdateSubresource(flags_.Get(), 0, &box, rowFlags_.data(), width_, 0);
        slots_[slot] = band;
        built_[slot] = {band, active_->endpoint(), active_->firstRecord()};
        if (!active_->needsRefresh(history)) pending_.erase(band);
        active_.reset();
        if (std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count() >= budget) break;
    }
}
const ReducedRow& WaterfallRenderer::inspect(const History& history, int64_t band) {
    static const ReducedRow unavailable;
    if (!height_ || band < 0 || band > newestBand_ || band <= newestBand_ - height_) return unavailable;
    const auto& built = built_[static_cast<size_t>(band % height_)];
    if (built.band != band || !built.endpoint || !built.first || !history.get(built.first) ||
        !history.get(built.first)->continuous || !history.get(built.endpoint)) return unavailable;
    if (inspectedBand_ != band || inspectedEndpoint_ != built.endpoint) {
        BandJob job(history, config_, band * framesPerBand(), (band + 1) * framesPerBand(), built.endpoint);
        job.step(history, metrics_, std::chrono::steady_clock::time_point::max());
        inspected_ = job.result(); inspectedBand_ = band; inspectedEndpoint_ = built.endpoint;
    }
    return inspected_;
}
void WaterfallRenderer::draw(unsigned palette) {
    if (!width_) return;
    const ShaderConfig config{static_cast<uint32_t>(config_.measurement), config_.bits, config_.changesOnly, config_.underlay,
        std::min(palette, 4u), 0, 0, height_, static_cast<uint32_t>(newestBand_ % height_), width_, 0, 0};
    context_->UpdateSubresource(constants_.Get(), 0, nullptr, &config, 0, 0);
    D3D11_VIEWPORT viewport{0, 0, static_cast<float>(width_), static_cast<float>(height_), 0, 1};
    context_->RSSetViewports(1, &viewport); context_->RSSetState(nullptr);
    ID3D11ShaderResourceView* unbound[8]{}; context_->PSSetShaderResources(0, 8, unbound);
    auto* target = target_.Get(); context_->OMSetRenderTargets(1, &target, nullptr);
    context_->OMSetBlendState(nullptr, nullptr, 0xffffffff); context_->OMSetDepthStencilState(nullptr, 0);
    context_->IASetInputLayout(nullptr); context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context_->VSSetShader(vertex_.Get(), nullptr, 0); context_->PSSetShader(pixel_.Get(), nullptr, 0); context_->GSSetShader(nullptr, nullptr, 0);
    auto* cb = constants_.Get(); context_->PSSetConstantBuffers(0, 1, &cb);
    ID3D11ShaderResourceView* inputs[8]{}; inputs[4] = paletteView_.Get(); inputs[6] = rowsView_.Get(); inputs[7] = flagsView_.Get();
    context_->PSSetShaderResources(0, 8, inputs); context_->Draw(3, 0);
    ID3D11ShaderResourceView* empty[8]{}; context_->PSSetShaderResources(0, 8, empty);
    context_->OMSetRenderTargets(0, nullptr, nullptr);
}
}
