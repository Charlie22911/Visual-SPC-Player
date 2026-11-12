#include "Spectrogram.h"
#include "kiss_fftr.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <new>
namespace visual_spc {
struct Spectrogram::Impl {
    unsigned fftSize, hopSize;
    std::vector<float> window, left, right, input, power, difference;
    std::vector<kiss_fft_cpx> output, leftOutput;
    kiss_fftr_cfg fft = nullptr;
    std::deque<SpectrumRow> rows;
    uint32_t generation = 0, discontinuity = 0;
    uint64_t nextFrame = 0;
    uint64_t segment = 0;
    RowSink sink = nullptr;
    void* sinkContext = nullptr;
    unsigned write = 0, available = 0, sinceRow = 0;
    float windowSum = 0;
    bool initialized = false, contiguous = false;
    Impl(unsigned size = FftSize, unsigned hop = HopSize,
        RowSink rowSink = nullptr, void* context = nullptr)
        : fftSize(size), hopSize(hop), window(size), left(size), right(size), input(size),
        power(size / 2 + 1), difference(size / 2 + 1),
        output(size / 2 + 1), leftOutput(size / 2 + 1), sink(rowSink), sinkContext(context) {
        fft = kiss_fftr_alloc(static_cast<int>(size), 0, nullptr, nullptr);
        if (!fft) throw std::bad_alloc();
        constexpr double pi = 3.14159265358979323846;
        for (unsigned i = 0; i < fftSize; ++i) {
            window[i] = static_cast<float>(0.5 - 0.5 * std::cos(2 * pi * i / fftSize));
            windowSum += window[i];
        }
    }
    ~Impl() { kiss_fftr_free(fft); }
    void clearInput() noexcept { write = available = sinceRow = 0; contiguous = false; }
    void transform(uint64_t frame) {
        std::fill(power.begin(), power.end(), 0.0f);
        for (unsigned channel = 0; channel < 2; ++channel) {
            const auto& samples = channel ? right : left;
            // Two contiguous spans avoid a variable integer division per sample
            // and allow the baseline compiler to vectorize the window multiply.
            const unsigned tail = fftSize - write;
            for (unsigned i = 0; i < tail; ++i)
                input[i] = samples[write + i] * window[i];
            for (unsigned i = tail; i < fftSize; ++i)
                input[i] = samples[i - tail] * window[i];
            kiss_fftr(fft, input.data(), output.data());
            for (unsigned bin = 0; bin < output.size(); ++bin) {
                const float scale = (bin == 0 || bin == fftSize / 2 ? 1.0f : 2.0f) / windowSum;
                const auto real = output[bin].r * scale, imaginary = output[bin].i * scale;
                power[bin] += (real * real + imaginary * imaginary) * 0.5f;
                if (!channel) leftOutput[bin] = {real, imaginary};
                else {
                    const auto differenceReal = leftOutput[bin].r - real;
                    const auto differenceImaginary = leftOutput[bin].i - imaginary;
                    difference[bin] = (differenceReal * differenceReal +
                        differenceImaginary * differenceImaginary) * 0.25f;
                }
            }
        }
        if (sink) {
            sink(sinkContext, {generation, frame, segment, power, difference});
        } else {
            // The reference/history adapter alone retains rows. Pop first so
            // the container never exceeds the published bound.
            while (!rows.empty() && (rows.size() >= SampleRate * 10 / hopSize ||
                frame - rows.front().nativeFrame >= SampleRate * 10))
                rows.pop_front();
            rows.push_back({generation, frame, power, difference});
        }
    }
};
Spectrogram::Spectrogram() : impl_(std::make_unique<Impl>()) {}
Spectrogram::Spectrogram(RowSink sink, void* context)
    : impl_(std::make_unique<Impl>(FftSize, HopSize, sink, context)) {}
Spectrogram::~Spectrogram() = default;
bool Spectrogram::configure(unsigned fftSize, unsigned hopSize) {
    if ((fftSize != 1024 && fftSize != 2048 && fftSize != 4096) ||
        (hopSize != 64 && hopSize != 128 && hopSize != 256 && hopSize != 512) ||
        hopSize > fftSize) return false;
    if (impl_->fftSize == fftSize && impl_->hopSize == hopSize) return true;
    auto replacement = std::make_unique<Impl>(fftSize, hopSize, impl_->sink, impl_->sinkContext);
    replacement->generation = impl_->generation;
    replacement->initialized = impl_->initialized;
    replacement->segment = impl_->segment;
    impl_ = std::move(replacement);
    return true;
}
unsigned Spectrogram::fftSize() const noexcept { return impl_->fftSize; }
unsigned Spectrogram::hopSize() const noexcept { return impl_->hopSize; }
unsigned Spectrogram::binCount() const noexcept { return impl_->fftSize / 2 + 1; }
void Spectrogram::reset(uint32_t generation) {
    impl_->rows.clear(); impl_->clearInput();
    impl_->generation = generation; impl_->initialized = true;
    ++impl_->segment;
}
const std::deque<SpectrumRow>& Spectrogram::rows() const noexcept { return impl_->rows; }
bool Spectrogram::ingest(const SpectrumPacket& packet) {
    auto& state = *impl_;
    if (!packet.frameCount || packet.frameCount > 512 ||
        packet.nativeFrame > std::numeric_limits<uint64_t>::max() - packet.frameCount ||
        (state.initialized && packet.generation < state.generation)) return false;
    if (!state.initialized || packet.generation != state.generation) reset(packet.generation);
    if (!state.contiguous || state.nextFrame != packet.nativeFrame || state.discontinuity != packet.discontinuity) {
        // A backwards frame within one generation starts a new timeline.
        if (state.contiguous && packet.nativeFrame < state.nextFrame) state.rows.clear();
        if (state.contiguous) ++state.segment;
        state.clearInput();
        state.discontinuity = packet.discontinuity;
    }
    state.contiguous = true;
    for (unsigned i = 0; i < packet.frameCount; ++i) {
        state.left[state.write] = packet.pcm[i * 2] / 32768.0f;
        state.right[state.write] = packet.pcm[i * 2 + 1] / 32768.0f;
        state.write = (state.write + 1) % state.fftSize;
        if (state.available < state.fftSize) {
            if (++state.available == state.fftSize) { state.transform(packet.nativeFrame + i + 1); state.sinceRow = 0; }
        } else if (++state.sinceRow == state.hopSize) {
            state.transform(packet.nativeFrame + i + 1); state.sinceRow = 0;
        }
    }
    state.nextFrame = packet.nativeFrame + packet.frameCount;
    return true;
}
}
