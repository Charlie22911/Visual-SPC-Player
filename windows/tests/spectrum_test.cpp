#include "model/Spectrogram.h"
#include "audio/AudioSource.h"
#include "test_check.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <memory>
#include <vector>
using namespace visual_spc;
namespace {
constexpr double pi = 3.14159265358979323846;
SpectrumPacket packet(uint64_t start, unsigned count = 512, uint32_t generation = 1,
    float amplitude = 0.5f, bool antiphase = false, unsigned bin = 64, unsigned fftSize = 2048) {
    SpectrumPacket result{};
    result.generation = generation; result.nativeFrame = start; result.frameCount = count;
    for (unsigned i = 0; i < count; ++i) {
        const auto sample = static_cast<int16_t>(std::lround(32768 * amplitude *
            std::sin(2 * pi * bin * static_cast<double>(start + i) / fftSize)));
        result.pcm[i * 2] = sample;
        result.pcm[i * 2 + 1] = antiphase ? static_cast<int16_t>(-sample) : sample;
    }
    return result;
}
bool feed(Spectrogram& model, uint64_t begin, uint64_t end, bool antiphase = false,
    float amplitude = 0.5f, uint32_t generation = 1) {
    for (auto frame = begin; frame < end; frame += 512)
        if (!model.ingest(packet(frame, static_cast<unsigned>(std::min<uint64_t>(512, end - frame)),
            generation, amplitude, antiphase, 64, model.fftSize()))) return false;
    return true;
}
}
int main() {
    // Each FFT/hop preset has calibrated bins and native-frame row cadence.
    for (const unsigned fftSize : {1024u, 2048u, 4096u}) {
        for (const unsigned hopSize : {64u, 128u, 256u, 512u}) {
            Spectrogram preset;
            CHECK(preset.configure(fftSize, hopSize));
            CHECK(preset.fftSize() == fftSize && preset.hopSize() == hopSize);
            CHECK(preset.binCount() == fftSize / 2 + 1);
            CHECK(feed(preset, 0, fftSize - 1));
            CHECK(preset.rows().empty());
            CHECK(feed(preset, fftSize - 1, fftSize + 3 * hopSize));
            CHECK(preset.rows().size() == 4);
            for (unsigned index = 0; index < preset.rows().size(); ++index) {
                const auto& row = preset.rows()[index];
                CHECK(row.nativeFrame == fftSize + index * hopSize);
                CHECK(row.power.size() == preset.binCount() && row.difference.size() == preset.binCount());
                CHECK(std::abs(row.power[64] - 0.25f) < 0.0001f);
                CHECK(row.difference[64] == 0);
            }
            preset.reset(1);
            CHECK(feed(preset, 0, fftSize, true, 32767.0f / 32768));
            CHECK(std::abs(10 * std::log10(preset.rows().front().difference[64])) < 0.002f);
        }
    }

    Spectrogram spectrum;
    CHECK(spectrum.fftSize() == Spectrogram::FftSize && spectrum.hopSize() == Spectrogram::HopSize);
    CHECK(feed(spectrum, 0, 1536));
    CHECK(spectrum.rows().empty());
    CHECK(feed(spectrum, 1536, 2048));
    CHECK(spectrum.rows().size() == 1);
    const auto first = spectrum.rows().front();
    CHECK(first.generation == 1 && first.nativeFrame == 2048);
    CHECK(std::abs(first.power[64] - 0.25f) < 0.0001f);
    CHECK(std::abs(10 * std::log10(first.power[64]) + 6.0206f) < 0.002f);
    CHECK(first.power[60] < 1e-9f);
    CHECK(std::abs(first.power[63] - 0.0625f) < 0.0001f); // Hann main lobe.
    for (auto difference : first.difference) CHECK(difference == 0);
    Spectrogram fullScale;
    for (unsigned start = 0; start < 2048; start += 512)
        CHECK(fullScale.ingest(packet(start, 512, 1, 32767.0f / 32768)));
    CHECK(std::abs(10 * std::log10(fullScale.rows().front().power[64])) < 0.002f);
    CHECK(feed(spectrum, 2048, 2560));
    CHECK(spectrum.rows().size() == 3);
    CHECK(spectrum.rows()[1].nativeFrame == 2304 && spectrum.rows()[2].nativeFrame == 2560);

    Spectrogram opposite;
    CHECK(feed(opposite, 0, 2048, true));
    CHECK(std::abs(opposite.rows().front().power[64] - first.power[64]) < 1e-7f);
    CHECK(std::abs(opposite.rows().front().difference[64] - first.power[64]) < 1e-7f);
    // Average channel power: a silent right channel reduces power by 3 dB.
    Spectrogram oneChannel;
    for (unsigned start = 0; start < 2048; start += 512) {
        auto samples = packet(start);
        for (unsigned i = 0; i < 512; ++i) samples.pcm[i * 2 + 1] = 0;
        CHECK(oneChannel.ingest(samples));
    }
    CHECK(std::abs(oneChannel.rows().front().power[64] - 0.125f) < 0.0001f);
    CHECK(std::abs(oneChannel.rows().front().difference[64] - 0.0625f) < 0.0001f);
    // DC and Nyquist use their single-sided calibration rather than the sine factor.
    Spectrogram dc, nyquist;
    for (unsigned start = 0; start < 2048; start += 512) {
        auto samples = packet(start, 512, 1, 0);
        for (unsigned i = 0; i < 512; ++i) samples.pcm[i * 2] = samples.pcm[i * 2 + 1] = 16384;
        CHECK(dc.ingest(samples));
        for (unsigned i = 0; i < 512; ++i)
            samples.pcm[i * 2] = samples.pcm[i * 2 + 1] = i % 2 ? -16384 : 16384;
        CHECK(nyquist.ingest(samples));
    }
    CHECK(std::abs(dc.rows().front().power[0] - 0.25f) < 0.0001f);
    CHECK(std::abs(nyquist.rows().front().power[1024] - 0.25f) < 0.0001f);

    // Missing packets discard partial windows; no FFT bridges the gap.
    CHECK(feed(spectrum, 4096, 5632));
    CHECK(spectrum.rows().size() == 3);
    CHECK(feed(spectrum, 5632, 6144));
    CHECK(spectrum.rows().size() == 4 && spectrum.rows().back().nativeFrame == 6144);
    auto discontinuous = packet(6144); discontinuous.discontinuity = 1;
    CHECK(spectrum.ingest(discontinuous));
    CHECK(spectrum.rows().size() == 4);
    spectrum.reset(2);
    CHECK(spectrum.rows().empty());
    CHECK(!spectrum.ingest(packet(0))); // Delayed previous-generation packets.
    for (unsigned start = 0; start < 2048; start += 512) CHECK(spectrum.ingest(packet(start, 512, 2)));
    CHECK(spectrum.rows().size() == 1 && spectrum.rows().front().generation == 2);
    auto invalid = packet(2048, 512, 2); invalid.frameCount = 513;
    CHECK(!spectrum.ingest(invalid));
    CHECK(spectrum.rows().size() == 1);

    // Unchanged and rejected configurations preserve both history and overlap.
    Spectrogram configured;
    CHECK(feed(configured, 0, 2048 + 128, false, 0.5f, 7));
    CHECK(configured.configure(2048, 256));
    CHECK(!configured.configure(512, 256));
    CHECK(!configured.configure(2048, 32));
    CHECK(!configured.configure(1024, 2048));
    CHECK(configured.rows().size() == 1);
    CHECK(feed(configured, 2176, 2304, false, 0.5f, 7));
    CHECK(configured.rows().size() == 2 && configured.rows().back().nativeFrame == 2304);
    CHECK(configured.configure(4096, 64));
    CHECK(configured.rows().empty());
    CHECK(!configured.ingest(packet(2304, 512, 6))); // Reconfiguration retains generation.
    CHECK(feed(configured, 2304, 2304 + 4095, false, 0.5f, 7));
    CHECK(configured.rows().empty());
    CHECK(feed(configured, 6399, 6400, false, 0.5f, 7));
    CHECK(configured.rows().size() == 1 && configured.rows().front().generation == 7);
    // A gap starts a full new window using the configured size.
    CHECK(feed(configured, 7000, 11095, true, 0.5f, 7));
    CHECK(configured.rows().size() == 1);
    CHECK(feed(configured, 11095, 11096, true, 0.5f, 7));
    CHECK(configured.rows().size() == 2 && configured.rows().back().nativeFrame == 11096);
    CHECK(std::abs(configured.rows().back().difference[64] - 0.25f) < 0.0001f);

    Spectrogram bounded;
    CHECK(feed(bounded, 0, 352000));
    CHECK(bounded.rows().size() == Spectrogram::MaxRows);
    CHECK(bounded.rows().back().nativeFrame - bounded.rows().front().nativeFrame < 320000);
    for (const unsigned hopSize : {64u, 128u, 256u, 512u}) {
        Spectrogram boundedPreset;
        CHECK(boundedPreset.configure(1024, hopSize));
        CHECK(feed(boundedPreset, 0, 352000));
        CHECK(boundedPreset.rows().size() == Spectrogram::SampleRate * 10 / hopSize);
        CHECK(boundedPreset.rows().back().nativeFrame - boundedPreset.rows().front().nativeFrame < 320000);
    }
    // Silence remains finite zero linear power, ready for the display dB floor.
    Spectrogram silence;
    for (unsigned start = 0; start < 2048; start += 512) CHECK(silence.ingest(packet(start, 512, 1, 0)));
    for (auto power : silence.rows().front().power) CHECK(power == 0);
    for (auto difference : silence.rows().front().difference) CHECK(difference == 0);

    // The bounded audio tap survives a full queue and records a detectable gap.
    std::vector<uint8_t> image(0x10180);
    const char signature[] = "SNES-SPC700 Sound File Data v0.30";
    std::memcpy(image.data(), signature, sizeof(signature) - 1);
    image[0x26] = 2;
    const uint8_t program[] = {0x8f, 0x4c, 0xf2, 0x8f, 0x01, 0xf3, 0x2f, 0xfe};
    std::memcpy(image.data() + 0x300, program, sizeof(program));
    image[0x10100] = image[0x10101] = image[0x1010c] = image[0x1011c] = 127;
    image[0x10103] = 0x10; image[0x10107] = 0x7f;
    image[0x1015d] = 0x10; image[0x1016c] = 0x20;
    image[0x1101] = image[0x1103] = 0x20; image[0x2100] = 0xc3;
    for (unsigned i = 1; i < 9; ++i) image[0x2100 + i] = 0x17;
    auto* instance = spc_native_create();
    CHECK(instance && spc_native_load(instance, image.data(), static_cast<uint32_t>(image.size()), 1) == 0);
    auto* reference = spc_native_create();
    CHECK(reference && spc_native_load(reference, image.data(), static_cast<uint32_t>(image.size()), 1) == 0);
    auto captures = std::make_unique<CaptureQueue>();
    auto queue = std::make_unique<SpectrumQueue>();
    auto source = std::make_unique<AudioSource>(48000, *captures, queue.get());
    CHECK(source->replace(instance, 1) == nullptr);
    source->setVolume(0); source->setPlaying(true);
    std::array<float, 960> left{}, right{};
    CHECK(source->render(left.data(), right.data(), left.size()));
    for (unsigned i = 0; i < left.size(); ++i) CHECK(left[i] == 0 && right[i] == 0);
    uint64_t expected = 0;
    bool tappedAudible = false;
    std::array<int16_t, 1024> raw{};
    while (const auto* samples = queue->consumer_slot()) {
        CHECK(samples->generation == 1 && samples->nativeFrame == expected);
        CHECK(samples->frameCount > 0 && samples->frameCount <= 512);
        CHECK(spc_native_render(reference, raw.data(), samples->frameCount) == 0);
        for (unsigned i = 0; i < samples->frameCount * 2; ++i) {
            CHECK(samples->pcm[i] == raw[i]); tappedAudible |= samples->pcm[i] != 0;
        }
        expected += samples->frameCount; queue->consume();
    }
    CHECK(tappedAudible); // PCM tap is independent of output volume and resampling.
    spc_native_destroy(reference);
    CHECK(expected == spc_native_generated_frames(instance));
    for (unsigned i = 0; i < 120; ++i) CHECK(source->render(left.data(), right.data(), left.size()));
    uint64_t beforeGap = 0;
    while (const auto* samples = queue->consumer_slot()) {
        beforeGap = samples->nativeFrame + samples->frameCount; queue->consume();
    }
    CHECK(beforeGap < spc_native_generated_frames(instance));
    CHECK(source->render(left.data(), right.data(), left.size()));
    CHECK(queue->consumer_slot() && queue->consumer_slot()->nativeFrame > beforeGap);
    while (queue->consumer_slot()) queue->consume();
    source->reconfigure(44100);
    CHECK(source->render(left.data(), right.data(), left.size()));
    CHECK(queue->consumer_slot() && queue->consumer_slot()->discontinuity == 1);
    while(queue->consumer_slot()) queue->consume();
    queue->setCaptureEnabled(false);
    const auto drops=queue->dropped();
    CHECK(source->render(left.data(),right.data(),left.size()));
    CHECK(!queue->consumer_slot() && queue->dropped()==drops);
    const auto resumeFrame=spc_native_generated_frames(instance);
    queue->setCaptureEnabled(true);
    CHECK(source->render(left.data(),right.data(),left.size()));
    CHECK(queue->consumer_slot() && queue->consumer_slot()->nativeFrame>=resumeFrame);
    CHECK(source->replace(nullptr, 2) == instance);
    spc_native_destroy(instance);
}

