#include "render/D3DDevice.h"
#include "render/SpectrogramRenderer.h"
#include "render/SpectrumReference.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace visual_spc;
namespace {
using Clock = std::chrono::steady_clock;
using Microsoft::WRL::ComPtr;
constexpr uint64_t Epoch = 1;
constexpr uint32_t Generation = 1;
constexpr unsigned RgbTolerance = 3; // At most one palette level plus UNORM rounding.

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}
double elapsedMs(Clock::time_point begin) {
    return std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
}
std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int bytes = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(bytes), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), bytes, nullptr, nullptr);
    return result;
}
std::string jsonString(const std::string& value) {
    std::ostringstream out;
    out << '"';
    for (const unsigned char character : value) {
        if (character == '"' || character == '\\') out << '\\' << character;
        else if (character < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(character) << std::dec;
        else out << character;
    }
    return out.str() + '"';
}

std::vector<uint32_t> readTexture(D3DDevice& device, ID3D11ShaderResourceView* view,
    unsigned expectedWidth, unsigned expectedHeight) {
    require(view != nullptr, "Spectrogram has no output texture");
    ComPtr<ID3D11Resource> resource;
    view->GetResource(&resource);
    ComPtr<ID3D11Texture2D> texture;
    checkGpu(resource.As(&texture));
    D3D11_TEXTURE2D_DESC description{};
    texture->GetDesc(&description);
    require(description.Width == expectedWidth && description.Height == expectedHeight,
        "Output texture does not have the requested physical resolution");
    require(description.Format == DXGI_FORMAT_R8G8B8A8_UNORM,
        "Readback expects RGBA8 output");
    description.BindFlags = 0;
    description.MiscFlags = 0;
    description.Usage = D3D11_USAGE_STAGING;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    checkGpu(device.device->CreateTexture2D(&description, nullptr, &staging));
    device.context->CopyResource(staging.Get(), texture.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    checkGpu(device.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));
    std::vector<uint32_t> result(static_cast<size_t>(expectedWidth) * expectedHeight);
    for (unsigned y = 0; y < expectedHeight; ++y)
        std::memcpy(result.data() + static_cast<size_t>(y) * expectedWidth,
            static_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch,
            static_cast<size_t>(expectedWidth) * sizeof(uint32_t));
    device.context->Unmap(staging.Get(), 0);
    return result;
}

std::vector<float> readProjectedRows(D3DDevice& device, ID3D11ShaderResourceView* view,
    unsigned expectedWidth, unsigned rowCount) {
    require(view != nullptr, "Spectrogram has no numeric projected texture");
    ComPtr<ID3D11Resource> resource;
    view->GetResource(&resource);
    ComPtr<ID3D11Texture2D> texture;
    checkGpu(resource.As(&texture));
    D3D11_TEXTURE2D_DESC description{};
    texture->GetDesc(&description);
    require(description.Width == expectedWidth && description.Height >= rowCount &&
        description.Format == DXGI_FORMAT_R32_FLOAT, "Unexpected numeric projected texture layout");
    description.Height = rowCount;
    description.BindFlags = 0; description.MiscFlags = 0;
    description.Usage = D3D11_USAGE_STAGING;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    checkGpu(device.device->CreateTexture2D(&description, nullptr, &staging));
    const D3D11_BOX box{0, 0, 0, expectedWidth, rowCount, 1};
    device.context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, texture.Get(), 0, &box);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    checkGpu(device.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));
    std::vector<float> result(static_cast<size_t>(expectedWidth) * rowCount);
    for (unsigned row = 0; row < rowCount; ++row)
        std::memcpy(result.data() + static_cast<size_t>(row) * expectedWidth,
            static_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(row) * mapped.RowPitch,
            static_cast<size_t>(expectedWidth) * sizeof(float));
    device.context->Unmap(staging.Get(), 0);
    return result;
}

SpectrumReferenceConfig referenceConfig(const SpectrumView& view, double frame, uint32_t generation = Generation) {
    SpectrumReferenceConfig config;
    config.width = view.width; config.height = view.height;
    config.fftSize = view.fftSize; config.hopSize = view.hopSize;
    config.sampling = view.sampling; config.temporal = view.temporal;
    config.temporalMs = view.temporalMs; config.seconds = view.seconds;
    config.logarithmic = view.logarithmic; config.difference = view.difference;
    config.floorDb = view.floorDb; config.ceilingDb = view.ceilingDb;
    config.palette = view.palette; config.mediaFrame = frame; config.generation = generation;
    return config;
}

SpectrumResult synthetic(unsigned row, unsigned fftSize = 1024, unsigned hopSize = 512,
    uint64_t origin = 0, uint64_t segment = 1) {
    SpectrumResult result;
    result.stamp = {Epoch, static_cast<uint64_t>(row) + 1,
        origin + fftSize + static_cast<uint64_t>(row) * hopSize, segment, Generation, fftSize / 2 + 1};
    for (unsigned bin = 0; bin < result.stamp.bins; ++bin) {
        // Deliberately nonseparable: time and frequency interpolation cannot be
        // accidentally exchanged with palette/dB interpolation and still match.
        const unsigned hash = (row * 83u + bin * 47u + row * bin * 13u) % 101u;
        const double db = -112.0 + hash * 1.06;
        result.power[bin] = static_cast<float>(std::pow(10.0, db / 10));
        result.difference[bin] = (bin + row) % 7u == 0 ? 0.0f : result.power[bin] * (0.03f + ((row + bin) % 11u) * 0.07f);
    }
    // Quiet positive bins after loud ones expose prefix-subtraction cancellation.
    for (unsigned bin = 7; bin + 2 < result.stamp.bins; bin += 53) {
        result.power[bin] = 1.0f;
        result.power[bin + 1] = 1e-10f;
        result.power[bin + 2] = 1e-11f;
    }
    return result;
}
SpectrumRow referenceRow(const SpectrumResult& result) {
    SpectrumRow row;
    row.generation = result.stamp.generation;
    row.nativeFrame = result.stamp.endFrame;
    row.power.assign(result.power.begin(), result.power.begin() + result.stamp.bins);
    row.difference.assign(result.difference.begin(), result.difference.begin() + result.stamp.bins);
    return row;
}
void finishProjection(SpectrogramRenderer& renderer) {
    for (unsigned pass = 0; pass < 10000; ++pass) {
        renderer.update(1000);
        if (renderer.stats().pending == 0) return;
    }
    throw std::runtime_error("Projection did not finish within the bounded test loop");
}
void uploadRows(SpectrogramRenderer& renderer, const std::deque<SpectrumRow>& rows,
    unsigned fftSize, unsigned hopSize, uint64_t origin = 0) {
    require(!rows.empty(), "Test requires source rows");
    const double audibleFrame = static_cast<double>(rows.back().nativeFrame);
    for (const auto& row : rows) {
        const unsigned index = static_cast<unsigned>((row.nativeFrame - origin - fftSize) / hopSize);
        auto result = synthetic(index, fftSize, hopSize, origin);
        std::copy(row.power.begin(), row.power.end(), result.power.begin());
        std::copy(row.difference.begin(), row.difference.end(), result.difference.begin());
        result.stamp.generation = row.generation;
        require(renderer.upload(result, audibleFrame), "Renderer rejected valid synthetic row");
    }
}
void compareProjected(D3DDevice& device, SpectrogramRenderer& renderer,
    const std::deque<SpectrumRow>& rows, const SpectrumView& view, const std::string& label) {
    // This helper is used only before ring wrap: upload ordinal is physical slot.
    finishProjection(renderer);
    const auto actual = readProjectedRows(device, renderer.projectedTexture(), view.width, static_cast<unsigned>(rows.size()));
    unsigned mismatches = 0;
    for (size_t row = 0; row < rows.size(); ++row) {
        auto config = referenceConfig(view, static_cast<double>(rows[row].nativeFrame));
        config.height = 1;
        // A one-native-frame footprint selects only this endpoint in Area mode;
        // temporal filtering still includes all of its valid causal source taps.
        config.seconds = 1.0 / 32000;
        const auto expected = referenceSpectrum(rows, config);
        for (unsigned x = 0; x < view.width; ++x) {
            const double value = actual[row * view.width + x];
            const double power = expected.power[x];
            // Positive R32 sums and float temporal/column weights incur rounding.
            // The tiny absolute term preserves meaningful checks at -120 dBFS.
            const double tolerance = std::max(1e-18, std::abs(power) * 1e-5);
            bool mismatch = !expected.available[x] || !std::isfinite(value) || value < 0 ||
                std::abs(value - power) > tolerance || (power == 0 && value != 0);
            // Check the single-pixel oracle entry point at the column boundaries
            // as well as the batched image used for the complete row.
            if (x == 0 || x == view.width / 2 || x + 1 == view.width) {
                const auto sample = referenceSpectrumPowerAt(rows, config, x, 0);
                mismatch |= !sample.available || sample.power != power;
            }
            if (mismatch && mismatches++ < 6)
                std::fprintf(stderr, "%s numeric slot %zu column %u: GPU %.12g CPU %.12g tolerance %.12g\n",
                    label.c_str(), row, x, value, power, tolerance);
        }
    }
    require(mismatches == 0, label + ": " + std::to_string(mismatches) + " numeric projected-power mismatches");
}
std::vector<uint32_t> compare(D3DDevice& device, SpectrogramRenderer& renderer,
    const std::deque<SpectrumRow>& rows, const SpectrumView& view, double frame,
    const std::string& label, bool requireAvailable = true) {
    finishProjection(renderer);
    renderer.draw(frame);
    const auto actual = readTexture(device, renderer.texture(), view.width, view.height);
    const auto expected = referenceSpectrum(rows, referenceConfig(view, frame));
    require(actual.size() == expected.rgba.size() && expected.power.size() == actual.size(), "Oracle image size mismatch");
    if (requireAvailable)
        require(std::find(expected.available.begin(), expected.available.end(), uint8_t{1}) != expected.available.end(),
            label + ": no measured pixels, so parity would only test the unavailable colour");
    unsigned mismatches = 0, maximumError = 0;
    for (size_t pixel = 0; pixel < actual.size(); ++pixel) {
        bool mismatch = (actual[pixel] >> 24) != 255;
        for (unsigned channel = 0; channel < 3; ++channel) {
            const auto a = int((actual[pixel] >> (channel * 8)) & 255u);
            const auto b = int((expected.rgba[pixel] >> (channel * 8)) & 255u);
            const unsigned error = static_cast<unsigned>(std::abs(a - b));
            maximumError = std::max(maximumError, error);
            mismatch |= error > RgbTolerance;
        }
        // Missing history is a distinct state, not measured silence.
        if (!expected.available[pixel]) mismatch |= actual[pixel] != SpectrumReferenceUnavailableColor;
        if (mismatch && mismatches++ < 6)
            std::fprintf(stderr, "%s at (%zu,%zu): GPU %08x CPU %08x power %.12g available %u\n",
                label.c_str(), pixel % view.width, pixel / view.width,
                actual[pixel], expected.rgba[pixel], expected.power[pixel], expected.available[pixel]);
    }
    require(mismatches == 0, label + ": " + std::to_string(mismatches) +
        " mismatched pixels, maximum RGB error " + std::to_string(maximumError));
    return actual;
}
SpectrumView smallView() {
    SpectrumView view;
    view.width = 31; view.height = 17; view.fftSize = 1024; view.hopSize = 512;
    view.seconds = 2; view.floorDb = -120; view.ceilingDb = 0;
    return view;
}

void parityMatrix(D3DDevice& device) {
    std::deque<SpectrumRow> rows;
    for (unsigned row = 0; row < 40; ++row) rows.push_back(referenceRow(synthetic(row)));
    SpectrogramRenderer renderer(device.device.Get(), device.context.Get());
    auto view = smallView();
    renderer.configure(view, Epoch, Generation);
    uploadRows(renderer, rows, view.fftSize, view.hopSize);
    unsigned cases = 0;
    for (unsigned sampling = 0; sampling < 3; ++sampling)
    for (bool logarithmic : {false, true})
    for (unsigned temporalMs : {0u, 1u, 25u, 200u})
    for (bool difference : {false, true})
    for (unsigned palette = 0; palette < 3; ++palette) {
        view.sampling = sampling; view.logarithmic = logarithmic;
        view.temporal = temporalMs != 0; view.temporalMs = temporalMs ? temporalMs : 25;
        view.difference = difference; view.palette = palette;
        renderer.configure(view, Epoch, Generation);
        const std::string label = "matrix mode=" + std::to_string(sampling) +
            " log=" + std::to_string(logarithmic) + " temporal=" + std::to_string(temporalMs) +
            " difference=" + std::to_string(difference) + " palette=" + std::to_string(palette);
        if (palette == 0) compareProjected(device, renderer, rows, view, label);
        compare(device, renderer, rows, view, static_cast<double>(rows.back().nativeFrame) + 83.25, label);
        ++cases;
    }
    std::printf("Spectrum CPU/GPU matrix: %u cases\n", cases);
}

void precisionAndEdges(D3DDevice& device) {
    // One bin per pixel, including DC and Nyquist. Dark bins immediately after
    // 0 dBFS bins must survive positive linear-power sampling at -120 dBFS.
    auto view = smallView();
    view.width = 513; view.height = 7; view.logarithmic = false;
    view.temporal = false; view.palette = 2;
    std::deque<SpectrumRow> rows;
    for (unsigned row = 0; row < 40; ++row) rows.push_back(referenceRow(synthetic(row)));
    SpectrogramRenderer renderer(device.device.Get(), device.context.Get());
    renderer.configure(view, Epoch, Generation);
    uploadRows(renderer, rows, view.fftSize, view.hopSize);
    for (unsigned sampling = 0; sampling < 3; ++sampling) {
        view.sampling = sampling;
        renderer.configure(view, Epoch, Generation);
        compareProjected(device, renderer, rows, view, "quiet-adjacent-bin mode=" + std::to_string(sampling));
        compare(device, renderer, rows, view, static_cast<double>(rows.back().nativeFrame), "quiet-adjacent-bin mode=" + std::to_string(sampling));
    }
    // Fractional frequency boundaries, an output pixel narrower than one bin,
    // and a one-pixel-high Area reduction use the oracle's exact membership.
    for (const unsigned width : {1u, 19u, 517u}) for (const unsigned height : {1u, 19u}) {
        view.width = width; view.height = height; view.sampling = 2; view.temporal = true;
        view.temporalMs = 200; view.logarithmic = width != 517;
        renderer.configure(view, Epoch, Generation);
        compareProjected(device, renderer, rows, view, "area-boundaries " + std::to_string(width) + "x" + std::to_string(height));
        compare(device, renderer, rows, view, static_cast<double>(rows.back().nativeFrame) + 0.125,
            "area-boundaries " + std::to_string(width) + "x" + std::to_string(height), height != 1);
    }
    // Equal stereo channels: difference is measured black in every palette.
    for (auto& row : rows) std::fill(row.difference.begin(), row.difference.end(), 0.0f);
    SpectrogramRenderer equal(device.device.Get(), device.context.Get());
    view = smallView(); view.difference = true; view.temporal = true; view.sampling = 1;
    equal.configure(view, Epoch, Generation);
    uploadRows(equal, rows, view.fftSize, view.hopSize);
    for (unsigned palette = 0; palette < 3; ++palette) {
        view.palette = palette; equal.configure(view, Epoch, Generation);
        compareProjected(device, equal, rows, view, "equal-channel difference");
        compare(device, equal, rows, view, static_cast<double>(rows.back().nativeFrame), "equal-channel difference");
    }
}

void lifecycleAndGaps(D3DDevice& device) {
    auto view = smallView();
    view.sampling = 1; view.temporal = true; view.temporalMs = 200;
    // Exact uint64 metadata must be translated near a local clock origin before
    // shader floats are used. This clock is well beyond single-float precision.
    constexpr uint64_t origin = uint64_t{1} << 40;
    std::deque<SpectrumRow> rows;
    for (unsigned row = 0; row < 40; ++row) {
        if (row >= 17 && row < 24) continue;
        rows.push_back(referenceRow(synthetic(row, view.fftSize, view.hopSize, origin, row < 17 ? 1 : 2)));
    }
    SpectrogramRenderer renderer(device.device.Get(), device.context.Get());
    renderer.configure(view, Epoch, Generation);
    uploadRows(renderer, rows, view.fftSize, view.hopSize, origin);
    compareProjected(device, renderer, rows, view, "long-clock/gap");
    const double frame = static_cast<double>(rows.back().nativeFrame) + 117.5;
    compare(device, renderer, rows, view, frame, "long-clock/gap");
    const auto before = renderer.stats();
    const auto paused = compare(device, renderer, rows, view, frame, "paused");
    const auto pausedAgain = compare(device, renderer, rows, view, frame, "paused-repeat");
    require(paused == pausedAgain, "A paused clock changed the output");
    require(renderer.stats().projected == before.projected && renderer.stats().uploaded == before.uploaded,
        "Repeated draws reuploaded/reprojected history");
    auto rejected = synthetic(80, view.fftSize, view.hopSize, origin);
    require(!renderer.upload(rejected, frame), "An over-ahead row exceeded the bounded staging allowance");
    rejected = synthetic(39, view.fftSize, view.hopSize, origin);
    rejected.stamp.analysisEpoch = Epoch + 1;
    require(!renderer.upload(rejected, frame), "A row from another analysis epoch was accepted");
    rejected.stamp.analysisEpoch = Epoch; rejected.stamp.generation = Generation + 1;
    require(!renderer.upload(rejected, frame), "A future-generation row was accepted");
    require(compare(device, renderer, rows, view, frame, "rejected rows preserve history") == paused,
        "Rejected rows altered audible history");
    const auto prepared = synthetic(40, view.fftSize, view.hopSize, origin, 2);
    require(renderer.upload(prepared, frame), "A valid prepared-audio row inside the ahead allowance was rejected");
    require(compare(device, renderer, rows, view, frame, "future audio remains inaudible") == paused,
        "Prepared future audio changed pixels before its audible timestamp");

    // Colour/height/time-only changes cannot trigger projected-history work.
    const auto projectionCount = renderer.stats().projected;
    view.palette = 1; view.floorDb = -105; view.ceilingDb = -3;
    renderer.configure(view, Epoch, Generation);
    compare(device, renderer, rows, view, frame, "colour invalidation");
    view.height = 23; view.seconds = 5;
    renderer.configure(view, Epoch, Generation);
    compare(device, renderer, rows, view, frame, "time/height invalidation");
    require(renderer.stats().projected == projectionCount, "Colour/height/time change rebuilt projected history");

    // Clock motion must draw at sub-hop and sub-60-Hz positions. Deliberately
    // large height resolves the movement in this short synthetic history.
    view = smallView(); view.height = 1024; view.sampling = 1; view.temporal = false;
    renderer.configure(view, Epoch, Generation);
    const auto motionA = compare(device, renderer, rows, view, frame, "scroll-before");
    const auto projectionBeforeScroll = renderer.stats().projected;
    const auto motionB = compare(device, renderer, rows, view, frame + 128, "scroll-after");
    require(motionA != motionB, "Audio clock advancement did not move the rendered history");
    require(renderer.stats().projected == projectionBeforeScroll, "Clock-only motion reprojected history");
}

void ringWrapAndRevision(D3DDevice& device) {
    auto view = smallView(); view.width = 11; view.height = 29; view.seconds = 10;
    view.sampling = 2; view.temporal = true; view.temporalMs = 200;
    SpectrogramRenderer renderer(device.device.Get(), device.context.Get());
    renderer.configure(view, Epoch, Generation);
    std::deque<SpectrumRow> rows;
    // Exceeds ten seconds plus guard/ahead capacity at the largest hop. The
    // missing interval remains in the visible window after the physical wrap.
    for (unsigned index = 0; index < 1100; ++index) {
        if (index >= 760 && index < 772) continue;
        auto result = synthetic(index, view.fftSize, view.hopSize, 0, index < 760 ? 1 : 2);
        rows.push_back(referenceRow(result));
        require(renderer.upload(result, static_cast<double>(result.stamp.endFrame)), "Ring-wrap upload rejected");
        if (index == 600) {
            // Superseded work must not project a subsequently reused raw slot.
            view.width = 13; renderer.configure(view, Epoch, Generation);
            renderer.update(0);
            view.width = 11; view.logarithmic = false;
            renderer.configure(view, Epoch, Generation);
        }
    }
    const double frame = static_cast<double>(rows.back().nativeFrame) + 0.5;
    compare(device, renderer, rows, view, frame, "ring wrap/revision/gap");
    for (const unsigned width : {17u, 7u, 31u}) {
        view.width = width; view.difference = !view.difference; view.logarithmic = !view.logarithmic;
        renderer.configure(view, Epoch, Generation);
        compare(device, renderer, rows, view, frame, "wrapped reprojection width=" + std::to_string(width));
    }
    // Epoch replacement clears old signal. No old generation can reappear.
    renderer.configure(view, Epoch + 1, Generation + 1);
    finishProjection(renderer);
    renderer.draw(frame);
    const auto cleared = readTexture(device, renderer.texture(), view.width, view.height);
    require(std::all_of(cleared.begin(), cleared.end(), [](uint32_t pixel) { return pixel == SpectrumReferenceUnavailableColor; }),
        "An epoch/generation change revealed stale history");
}

// Benchmark-only synchronous query collection. The live player must not wait
// for these timestamps. Results describe D3D work, not present/display cadence.
class GpuTimer {
    D3DDevice& device_;
    ComPtr<ID3D11Query> disjoint_, begin_, end_;
    template<class T> void get(ID3D11Query* query, T& value) {
        const auto deadline = Clock::now() + std::chrono::seconds(60);
        for (;;) {
            const HRESULT result = device_.context->GetData(query, &value, sizeof(value), 0);
            checkGpu(result);
            if (result == S_OK) return;
            require(Clock::now() < deadline, "GPU timing query timed out");
            Sleep(1);
        }
    }
public:
    explicit GpuTimer(D3DDevice& device) : device_(device) {
        D3D11_QUERY_DESC description{D3D11_QUERY_TIMESTAMP_DISJOINT, 0};
        checkGpu(device.device->CreateQuery(&description, &disjoint_));
        description.Query = D3D11_QUERY_TIMESTAMP;
        checkGpu(device.device->CreateQuery(&description, &begin_));
        checkGpu(device.device->CreateQuery(&description, &end_));
    }
    void begin() { device_.context->Begin(disjoint_.Get()); device_.context->End(begin_.Get()); }
    double end() {
        device_.context->End(end_.Get()); device_.context->End(disjoint_.Get()); device_.context->Flush();
        D3D11_QUERY_DATA_TIMESTAMP_DISJOINT disjoint{};
        UINT64 begin = 0, end = 0;
        get(disjoint_.Get(), disjoint); get(begin_.Get(), begin); get(end_.Get(), end);
        require(!disjoint.Disjoint && disjoint.Frequency && end >= begin, "GPU timestamp interval was disjoint");
        return 1000.0 * static_cast<double>(end - begin) / static_cast<double>(disjoint.Frequency);
    }
};
double percentile(std::vector<double> values, double fraction) {
    require(!values.empty(), "Empty timing sample");
    std::sort(values.begin(), values.end());
    return values[static_cast<size_t>(std::ceil(fraction * values.size())) - 1];
}
std::string benchmarkResolution(D3DDevice& device, unsigned width, unsigned height, bool stress) {
    SpectrumView view;
    view.width = width; view.height = height; view.seconds = 10;
    view.fftSize = stress ? 4096 : 2048; view.hopSize = stress ? 64 : 256;
    view.sampling = 2; view.temporal = true; view.temporalMs = stress ? 200 : 25;
    view.logarithmic = true; view.floorDb = -120;
    SpectrogramRenderer renderer(device.device.Get(), device.context.Get());
    renderer.configure(view, Epoch, Generation);
    const unsigned rows = (32000u * 102u / 10u + view.hopSize - 1) / view.hopSize;
    // Signal generation and its allocations are excluded from upload timings.
    std::vector<SpectrumResult> input(rows);
    for (unsigned row = 0; row < rows; ++row) input[row] = synthetic(row, view.fftSize, view.hopSize);
    GpuTimer timer(device);
    timer.begin();
    auto begin = Clock::now();
    for (unsigned row = 0; row < rows; ++row) {
        const auto& result = input[row];
        require(renderer.upload(result, static_cast<double>(result.stamp.endFrame)), "Benchmark row rejected");
    }
    const double uploadCpuMs = elapsedMs(begin);
    const double uploadGpuMs = timer.end();
    timer.begin(); begin = Clock::now();
    finishProjection(renderer);
    const double projectionCpuMs = elapsedMs(begin);
    const double projectionGpuMs = timer.end();
    const double frame = view.fftSize + static_cast<double>(rows - 1) * view.hopSize;
    renderer.draw(frame); // First-use shader/pipeline work is outside steady state.
    const auto warmed = renderer.stats();
    const unsigned draws = device.software ? 30 : 120;
    std::vector<double> submitMs;
    submitMs.reserve(draws);
    timer.begin();
    for (unsigned draw = 0; draw < draws; ++draw) {
        begin = Clock::now();
        renderer.draw(frame + draw * 2.0);
        submitMs.push_back(elapsedMs(begin));
    }
    const double drawGpuMs = timer.end() / draws;
    const auto final = renderer.stats();
    require(final.uploaded == warmed.uploaded && final.projected == warmed.projected,
        "Steady-state draws rebuilt or uploaded history");
    require(final.draws - warmed.draws == draws, "Steady-state draw counter mismatch");
    // Reading proves the submitted draw completed at the requested resolution.
    readTexture(device, renderer.texture(), width, height);
    std::ostringstream out;
    out << std::fixed << std::setprecision(6)
        << "{\"width\":" << width << ",\"height\":" << height
        << ",\"fftSize\":" << view.fftSize << ",\"hopSize\":" << view.hopSize
        << ",\"sampling\":\"Area\",\"temporalMs\":" << view.temporalMs
        << ",\"logarithmic\":true,\"difference\":false,\"seconds\":10"
        << ",\"rowsSubmitted\":" << rows << ",\"resourceBytes\":" << final.bytes
        << ",\"uploadCpuMs\":" << uploadCpuMs << ",\"uploadGpuMs\":" << uploadGpuMs
        << ",\"projectionCpuMs\":" << projectionCpuMs << ",\"projectionGpuMs\":" << projectionGpuMs
        << ",\"steadyDraws\":" << draws << ",\"steadyDrawCpuP50Ms\":" << percentile(submitMs, .50)
        << ",\"steadyDrawCpuP95Ms\":" << percentile(submitMs, .95)
        << ",\"steadyDrawCpuP99Ms\":" << percentile(submitMs, .99)
        << ",\"steadyDrawGpuMeanMs\":" << drawGpuMs
        << ",\"steadyUploadedRows\":" << final.uploaded - warmed.uploaded
        << ",\"steadyProjectedRows\":" << final.projected - warmed.projected << "}";
    return out.str();
}
void benchmark(D3DDevice& device, const std::filesystem::path& path, bool stress) {
    std::ostringstream output;
    output << "{\n  \"adapter\": " << jsonString(utf8(device.adapterName))
        << ",\n  \"software\": " << (device.software ? "true" : "false")
#ifdef NDEBUG
        << ",\n  \"build\": \"Release\""
#else
        << ",\n  \"build\": \"Debug\""
#endif
        << ",\n  \"scope\": \"Synthetic D3D upload/projection/draw; excludes FFT, audio, UI and Present. WARP is not hardware performance.\""
        << ",\n  \"measurements\": [\n";
    output << "    " << benchmarkResolution(device, 1920, 1080, stress) << ",\n";
    output << "    " << benchmarkResolution(device, 3840, 2160, stress) << "\n  ]\n}\n";
    if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    require(file.good(), "Cannot open private benchmark JSON output");
    file << output.str(); file.close();
    require(file.good(), "Cannot write private benchmark JSON output");
    std::printf("Spectrum GPU benchmark: %s\n", path.string().c_str());
}
}

int main(int argc, char** argv) {
    try {
        bool hardware = false, runBenchmark = false, benchmarkOnly = false, stress = false;
        std::filesystem::path benchmarkPath = ".local/spectrum-gpu-performance.json";
        for (int argument = 1; argument < argc; ++argument) {
            const std::string option = argv[argument];
            if (option == "--hardware") hardware = true;
            else if (option == "--bench") {
                runBenchmark = true;
                if (argument + 1 < argc && std::string(argv[argument + 1]).rfind("--", 0) != 0)
                    benchmarkPath = argv[++argument];
            } else if (option == "--bench-only") { runBenchmark = true; benchmarkOnly = true; }
            else if (option == "--stress") stress = true;
            else throw std::runtime_error("Unknown option: " + option);
        }
        D3DDevice device(nullptr, !hardware);
        require(!hardware || !device.software, "--hardware requested but hardware D3D11 was unavailable");
        std::printf("Spectrum GPU: %s (%s)\n", utf8(device.adapterName).c_str(), device.software ? "WARP" : "hardware");
        if (!benchmarkOnly) {
            parityMatrix(device);
            precisionAndEdges(device);
            lifecycleAndGaps(device);
            ringWrapAndRevision(device);
            std::puts("Spectrum GPU parity and lifecycle checks passed");
        }
        if (runBenchmark) benchmark(device, benchmarkPath, stress);
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
