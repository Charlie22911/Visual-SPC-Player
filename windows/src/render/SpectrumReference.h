#pragma once
#include "model/Spectrogram.h"
#include <cstdint>
#include <deque>
#include <vector>

namespace visual_spc {
inline constexpr uint32_t SpectrumReferenceUnavailableColor = 0xff0c0502u;

// The native CPU sampler's physical-pixel, linear-power display settings.
// Sampling: 0 = nearest frequency/causal time, 1 = smooth, 2 = whole-bin/row area.
struct SpectrumReferenceConfig {
    unsigned width = 1, height = 1;
    unsigned fftSize = 2048, hopSize = 256;
    unsigned sampling = 0;
    bool temporal = false;
    unsigned temporalMs = 25;
    double seconds = 5;
    bool logarithmic = false, difference = false;
    float floorDb = -90, ceilingDb = 0;
    unsigned palette = 0;
    double mediaFrame = 0;
    uint32_t generation = 0;
};
struct SpectrumReferenceSample {
    double power = 0;
    bool available = false;
};
struct SpectrumReferenceImage {
    // Row-major physical pixels. Unavailable numerical samples contain zero;
    // available distinguishes them from measured silence.
    std::vector<double> power;
    std::vector<uint32_t> rgba;
    std::vector<uint8_t> available;
};

// Rows must be in increasing native-frame order and have fftSize/2+1 bins.
// Smoothing uses normalized positive sums, never wide prefix subtraction.
// There is no 60 Hz clock quantization or graphics dependency in the oracle.
SpectrumReferenceSample referenceSpectrumPowerAt(const std::deque<SpectrumRow>&,
    const SpectrumReferenceConfig&, unsigned x, unsigned y);
SpectrumReferenceImage referenceSpectrum(const std::deque<SpectrumRow>&,
    const SpectrumReferenceConfig&);
void referenceSpectrumInto(const std::deque<SpectrumRow>&,
    const SpectrumReferenceConfig&, std::vector<uint32_t>& rgba);
}
