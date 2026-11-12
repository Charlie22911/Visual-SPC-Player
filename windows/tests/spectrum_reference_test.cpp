#include "render/SpectrumReference.h"
#include "model/SpectrumColors.h"
#include "test_check.h"
#include <algorithm>
#include <cmath>
#include <deque>

using namespace visual_spc;
namespace {
SpectrumRow row(uint64_t frame, float value, unsigned bins = 5, uint32_t generation = 1) {
    SpectrumRow result;
    result.generation = generation;
    result.nativeFrame = frame;
    result.power.assign(bins, value);
    result.difference.assign(bins, 0);
    return result;
}
bool near(double actual, double expected, double tolerance = 1e-10) {
    return std::abs(actual - expected) <= tolerance * std::max(1.0, std::abs(expected));
}
SpectrumReferenceConfig config() {
    SpectrumReferenceConfig result;
    result.width = 2; result.height = 1;
    result.fftSize = 8; result.hopSize = 64;
    result.generation = 1; result.mediaFrame = 256;
    result.seconds = 128.0 / 32000;
    return result;
}
}
int main() {
    auto view = config();
    std::deque<SpectrumRow> rows;
    CHECK(!referenceSpectrumPowerAt(rows, view, 0, 0).available);
    rows.push_back(row(256, 1));
    rows.front().power = {0, 1, 4, 9, 16};

    // Nearest frequency rounds the pixel centre; time holds the last causal row.
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 1));
    CHECK(near(referenceSpectrumPowerAt(rows, view, 1, 0).power, 9));
    CHECK(!referenceSpectrumPowerAt(rows, view, 2, 0).available);
    CHECK(!referenceSpectrumPowerAt(rows, view, 0, 1).available);
    view.mediaFrame = 255;
    CHECK(!referenceSpectrumPowerAt(rows, view, 0, 0).available);
    view.mediaFrame = 384;
    CHECK(referenceSpectrumPowerAt(rows, view, 0, 0).available); // Inclusive two-hop tolerance.
    view.mediaFrame = 384.01;
    CHECK(!referenceSpectrumPowerAt(rows, view, 0, 0).available);

    // Area preserves the original whole-bin membership, excluding the right boundary.
    view = config(); view.sampling = 2;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 0.5));
    CHECK(near(referenceSpectrumPowerAt(rows, view, 1, 0).power, 6.5));
    rows = {row(128, 2), row(192, 4), row(256, 8)};
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 14.0 / 3));
    view.seconds = 127.0 / 32000;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 6));
    rows = {row(64, 1000), row(192, 4), row(256, 8)};
    view.seconds = 1;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 6)); // Stops at a gap.
    view.seconds = 0.00001; view.mediaFrame = 257;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 8)); // Always retains latest.

    // Smooth combines linear power. Its following endpoint must already be audible.
    rows = {row(256, 2), row(320, 10)};
    view = config(); view.sampling = 1; view.height = 2;
    view.seconds = 64.0 / 32000; view.mediaFrame = 320;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 1).power, 6));
    view.mediaFrame = 319;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 1).power, 2));
    rows.back().nativeFrame = 384;
    view.mediaFrame = 384;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 1).power, 2)); // No interpolation over gap.
    rows = {row(256, 0)}; rows.front().power = {0, 2, 4, 6, 8};
    view = config(); view.sampling = 1; view.width = 4;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 1));
    CHECK(near(referenceSpectrumPowerAt(rows, view, 3, 0).power, 7));

    // Finite exponential smoothing is causal and has the original decimated tap support.
    rows.clear();
    for (unsigned index = 0; index < 20; ++index) rows.push_back(row(1024 + index * 64, static_cast<float>(index + 1)));
    view = config(); view.mediaFrame = static_cast<double>(rows.back().nativeFrame);
    view.temporal = true; view.temporalMs = 16; // radius 8: exactly nine taps.
    double expected = 0, norm = 0;
    for (unsigned age = 0; age <= 8; ++age) {
        const auto weight = std::exp(-double(age * 64) / 512);
        expected += (20 - age) * weight; norm += weight;
    }
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, expected / norm));
    view.temporalMs = 25; // radius 12, step 2; not a recursive or dense filter.
    expected = norm = 0;
    for (unsigned age = 0; age <= 12; age += 2) {
        const auto weight = std::exp(-double(age * 64) / 800);
        expected += (20 - age) * weight; norm += weight;
    }
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, expected / norm));
    for (unsigned index = 0; index < 19; ++index) rows[index].nativeFrame -= 64;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 20));

    // Startup normalizes only existing causal taps, and a new generation never mixes.
    rows = {row(256, 3)};
    view = config(); view.temporal = true; view.temporalMs = 200;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 3));
    view.generation = 2;
    CHECK(!referenceSpectrumPowerAt(rows, view, 0, 0).available);
    rows.push_back(row(320, 7, 5, 2)); view.mediaFrame = 320;
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 0).power, 7));

    // Positive sums preserve a quiet bin even after thousands of full-scale bins.
    view = config(); view.fftSize = 4096; view.width = 4098;
    rows = {row(256, 1, 2049)}; rows.front().power.back() = 1e-12f;
    const auto quiet = referenceSpectrumPowerAt(rows, view, view.width - 1, 0);
    CHECK(quiet.available && std::abs(quiet.power - static_cast<double>(1e-12f)) < 1e-20);
    view.difference = true;
    CHECK(referenceSpectrumPowerAt(rows, view, view.width - 1, 0).power == 0);

    // Log frequency uses the original 20 Hz..16 kHz mapping at pixel centres.
    view = config(); view.fftSize = 1024; view.width = 7; view.logarithmic = true;
    rows = {row(256, 0, 513)};
    for (unsigned bin = 0; bin < 513; ++bin) rows.front().power[bin] = static_cast<float>(bin);
    for (unsigned x = 0; x < view.width; ++x) {
        const auto bin = static_cast<unsigned>(20 * std::pow(800.0, (x + 0.5) / view.width) * 1024 / 32000 + 0.5);
        CHECK(near(referenceSpectrumPowerAt(rows, view, x, 0).power, bin));
    }

    // Relative differences remain stable far into the native-frame clock.
    const uint64_t origin = uint64_t{1} << 45;
    rows = {row(origin + 256, 2), row(origin + 320, 10)};
    view = config(); view.sampling = 1; view.height = 2;
    view.seconds = 64.0 / 32000; view.mediaFrame = static_cast<double>(origin + 320);
    CHECK(near(referenceSpectrumPowerAt(rows, view, 0, 1).power, 6));

    // Numerical and final RGBA APIs share availability, dBFS clamping, and quantization.
    rows = {row(256, 0.01f)}; view = config(); view.height = 2;
    view.floorDb = -120; view.ceilingDb = 0;
    for (const unsigned palette : {0u, 1u, 2u}) {
        view.palette = palette;
        const auto image = referenceSpectrum(rows, view);
        CHECK(image.power.size() == 4 && image.rgba.size() == 4 && image.available.size() == 4);
        CHECK(image.available[0] && !image.available[2]);
        const unsigned level = static_cast<unsigned>((10 * std::log10(double(0.01f)) + 120) / 120 * 255);
        CHECK(image.rgba[0] == spectrumColor(level, palette));
        CHECK(image.rgba[2] == SpectrumReferenceUnavailableColor);
        std::vector<uint32_t> pixels;
        referenceSpectrumInto(rows, view, pixels);
        CHECK(pixels == image.rgba);
    }
    view.difference = true;
    CHECK(referenceSpectrum(rows, view).rgba[0] == spectrumColor(0, 2));
    view.width = 0;
    CHECK(referenceSpectrum(rows, view).rgba.empty());
}
