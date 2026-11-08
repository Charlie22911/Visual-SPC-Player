#include "AudioEngine.h"
#include "AudioSource.h"
#include <Windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <avrt.h>
#include <ksmedia.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <thread>
#include <stdexcept>
namespace visual_spc {
using Microsoft::WRL::ComPtr;
namespace {
struct AudioError { HRESULT code; };
void checked(HRESULT hr) { if (FAILED(hr)) throw AudioError{hr}; }
struct FormatFree { void operator()(WAVEFORMATEX* p) const noexcept { CoTaskMemFree(p); } };
struct Endpoint {
    ComPtr<IAudioClient> client;
    ComPtr<IAudioRenderClient> renderer;
    ComPtr<IAudioClock> clock;
    std::unique_ptr<WAVEFORMATEX, FormatFree> format;
    HANDLE event = nullptr;
    UINT32 bufferFrames = 0;
    UINT32 periodFrames = 0;
    UINT64 frequency = 0;
    bool floating = false;
    unsigned validBits = 0, leftChannel = 0, rightChannel = 1;
    ~Endpoint() { if (client) client->Stop(); if (event) CloseHandle(event); }
};
std::unique_ptr<Endpoint> openEndpoint(IMMDeviceEnumerator* enumerator) {
    auto endpoint = std::make_unique<Endpoint>();
    ComPtr<IMMDevice> device;
    checked(enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device));
    checked(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &endpoint->client));
    WAVEFORMATEX* raw = nullptr;
    checked(endpoint->client->GetMixFormat(&raw)); endpoint->format.reset(raw);
    auto& format = *raw;
    if (!format.nChannels || format.nChannels > 32 || !format.nSamplesPerSec) throw AudioError{AUDCLNT_E_UNSUPPORTED_FORMAT};
    endpoint->floating = format.wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    endpoint->validBits = format.wBitsPerSample;
    DWORD mask = 0;
    if (format.wFormatTag == WAVE_FORMAT_EXTENSIBLE && format.cbSize >= 22) {
        const auto& extended = *reinterpret_cast<WAVEFORMATEXTENSIBLE*>(raw);
        endpoint->floating = extended.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
        if (!endpoint->floating && extended.SubFormat != KSDATAFORMAT_SUBTYPE_PCM) throw AudioError{AUDCLNT_E_UNSUPPORTED_FORMAT};
        endpoint->validBits = extended.Samples.wValidBitsPerSample;
        mask = extended.dwChannelMask;
    } else if (!endpoint->floating && format.wFormatTag != WAVE_FORMAT_PCM) throw AudioError{AUDCLNT_E_UNSUPPORTED_FORMAT};
    if (endpoint->floating ? format.wBitsPerSample != 32 :
        (format.wBitsPerSample != 16 && format.wBitsPerSample != 24 && format.wBitsPerSample != 32))
        throw AudioError{AUDCLNT_E_UNSUPPORTED_FORMAT};
    if (!endpoint->validBits || endpoint->validBits > format.wBitsPerSample ||
        format.nBlockAlign != format.nChannels * (format.wBitsPerSample / 8)) throw AudioError{AUDCLNT_E_UNSUPPORTED_FORMAT};
    if (mask) {
        unsigned index = 0;
        for (unsigned bit = 0; bit < 32; ++bit) if (mask & (1u << bit)) {
            if ((1u << bit) == SPEAKER_FRONT_LEFT) endpoint->leftChannel = index;
            if ((1u << bit) == SPEAKER_FRONT_RIGHT) endpoint->rightChannel = index;
            ++index;
        }
    }
    endpoint->event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!endpoint->event) throw AudioError{HRESULT_FROM_WIN32(GetLastError())};
    ComPtr<IAudioClient3> client3;
    HRESULT initialized = E_NOINTERFACE;
    if (SUCCEEDED(endpoint->client.As(&client3))) {
        UINT32 normal = 0, fundamental = 0, minimum = 0, maximum = 0;
        if (SUCCEEDED(client3->GetSharedModeEnginePeriod(raw, &normal, &fundamental, &minimum, &maximum)) && fundamental) {
            auto requested = static_cast<UINT32>((format.nSamplesPerSec * 5ull + 999) / 1000);
            requested = std::clamp(((requested + fundamental - 1) / fundamental) * fundamental, minimum, maximum);
            initialized = client3->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, requested, raw, nullptr);
        }
    }
    if (FAILED(initialized)) {
        client3.Reset(); endpoint->client.Reset();
        checked(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &endpoint->client));
        checked(endpoint->client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            0, 0, raw, nullptr));
    }
    checked(endpoint->client->SetEventHandle(endpoint->event));
    checked(endpoint->client->GetBufferSize(&endpoint->bufferFrames));
    ComPtr<IAudioClient3> runningClient3;
    if (SUCCEEDED(endpoint->client.As(&runningClient3))) {
        WAVEFORMATEX* periodFormat = nullptr;
        const auto queried = runningClient3->GetCurrentSharedModeEnginePeriod(&periodFormat, &endpoint->periodFrames);
        CoTaskMemFree(periodFormat);
        if (FAILED(queried)) endpoint->periodFrames = 0;
    }
    if (!endpoint->periodFrames) {
        REFERENCE_TIME period = 0, minimum = 0;
        checked(endpoint->client->GetDevicePeriod(&period, &minimum));
        endpoint->periodFrames = static_cast<UINT32>(period * format.nSamplesPerSec / 10000000);
    }
    checked(endpoint->client->GetService(IID_PPV_ARGS(&endpoint->renderer)));
    checked(endpoint->client->GetService(IID_PPV_ARGS(&endpoint->clock)));
    checked(endpoint->clock->GetFrequency(&endpoint->frequency));
    if (!endpoint->frequency) throw AudioError{E_UNEXPECTED};
    return endpoint;
}
class DeviceNotification final : public IMMNotificationClient {
    std::atomic<ULONG> refs_{1};
    std::atomic<unsigned>& revision_;
    HANDLE wake_;
public:
    DeviceNotification(std::atomic<unsigned>& revision, HANDLE wake) : revision_(revision), wake_(wake) {}
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
    ULONG STDMETHODCALLTYPE Release() override { const auto n = --refs_; if (!n) delete this; return n; }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
        if (!object) return E_POINTER;
        *object = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IMMNotificationClient)) {
            *object = static_cast<IMMNotificationClient*>(this); AddRef(); return S_OK;
        }
        return E_NOINTERFACE;
    }
    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR) override {
        if (flow == eRender && role == eMultimedia) { ++revision_; SetEvent(wake_); } return S_OK;
    }
    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { ++revision_; SetEvent(wake_); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { ++revision_; SetEvent(wake_); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { ++revision_; SetEvent(wake_); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }
};
void convert(const Endpoint& endpoint, BYTE* output, const float* left, const float* right, UINT32 frames) noexcept {
    const auto& format = *endpoint.format;
    std::memset(output, 0, static_cast<size_t>(frames) * format.nBlockAlign);
    const unsigned sampleBytes = format.wBitsPerSample / 8;
    for (UINT32 frame = 0; frame < frames; ++frame) {
        for (unsigned channel = 0; channel < format.nChannels; ++channel) {
            float value = 0;
            if (format.nChannels == 1) value = (left[frame] + right[frame]) * 0.5f;
            else if (channel == endpoint.leftChannel) value = left[frame];
            else if (channel == endpoint.rightChannel) value = right[frame];
            value = std::clamp(value, -1.0f, 1.0f);
            auto* destination = output + static_cast<size_t>(frame) * format.nBlockAlign + channel * sampleBytes;
            if (endpoint.floating) std::memcpy(destination, &value, sizeof(value));
            else {
                const double scale = std::ldexp(1.0, static_cast<int>(endpoint.validBits) - 1);
                const auto quantized = static_cast<int64_t>(std::clamp(std::round(value * scale), -scale, scale - 1));
                const auto packed = static_cast<uint32_t>(quantized) << (format.wBitsPerSample - endpoint.validBits);
                for (unsigned byte = 0; byte < sampleBytes; ++byte) destination[byte] = static_cast<BYTE>(packed >> (byte * 8));
            }
        }
    }
}
}
struct AudioEngine::Impl {
    enum class Kind { Replace, Play, Volume, Rate };
    struct Command { Kind kind; spc_native_instance* instance = nullptr; uint32_t first = 0, second = 0; float value = 0; };
    std::unique_ptr<CaptureQueue> captures = std::make_unique<CaptureQueue>();
    SpscRing<Command, 16> commands;
    SpscRing<spc_native_instance*, 32> retired;
    SpscRing<ClockAnchor, 128> anchors;
    std::atomic<bool> stop{false};
    std::atomic<unsigned> deviceRevision{0}, rate{0};
    std::atomic<long> error{0};
    HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    std::thread thread;
    spc_native_instance* shutdownHandle = nullptr;
    uint32_t lastEnqueuedGeneration = 0;
    Impl() {
        if (!wake) throw std::runtime_error("Audio event creation failed");
        try { thread = std::thread([this] { run(); }); }
        catch (...) { CloseHandle(wake); throw; }
    }
    ~Impl() {
        stop = true; SetEvent(wake); if (thread.joinable()) thread.join();
        spc_native_destroy(shutdownHandle);
        while (const auto* handle = retired.consumer_slot()) { spc_native_destroy(*handle); retired.consume(); }
        while (const auto* command = commands.consumer_slot()) {
            if (command->kind == Kind::Replace) spc_native_destroy(command->instance);
            commands.consume();
        }
        CloseHandle(wake);
    }
    bool push(Command command) {
        auto* slot = commands.producer_slot(); if (!slot) return false;
        *slot = command; commands.publish(); SetEvent(wake); return true;
    }
    void processCommands(AudioSource& source, bool& wantedPlaying, bool& fading,
        const PlaybackTimeline& timeline, uint64_t epoch, double played) noexcept {
        while (const auto* command = commands.consumer_slot()) {
            if (command->kind == Kind::Replace) {
                auto* retirement = retired.producer_slot();
                if (!retirement || timeline.unplayedGenerations(epoch, played) >= 3) return;
                if (!fading) { source.setPlaying(false); fading = true; }
                if (!source.silent()) return;
                auto* old = source.replace(command->instance, command->first);
                if (old) { *retirement = old; retired.publish(); }
                source.setPlaying(wantedPlaying); fading = false;
                commands.consume(); return; // one transition per fill cycle
            }
            switch (command->kind) {
            case Kind::Play: wantedPlaying = command->first != 0; source.setPlaying(wantedPlaying); break;
            case Kind::Volume: source.setVolume(command->value); break;
            case Kind::Rate: source.setCaptureRate(command->first, command->second); break;
            default: break;
            }
            commands.consume();
        }
    }
    void run() noexcept {
        const auto com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(com)) { error = com; return; }
        std::unique_ptr<AudioSource> source;
        ComPtr<IMMDeviceEnumerator> enumerator;
        ComPtr<DeviceNotification> notification;
        DWORD taskIndex = 0;
        HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);
        try {
            checked(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)));
            notification.Attach(new DeviceNotification(deviceRevision, wake));
            checked(enumerator->RegisterEndpointNotificationCallback(notification.Get()));
            source = std::make_unique<AudioSource>(48000, *captures);
            uint64_t epoch = 0;
            bool wantedPlaying = false, fading = false;
            while (!stop) {
                PlaybackTimeline timeline;
                uint64_t submitted = 0;
                double played = 0;
                try {
                    const auto revision = deviceRevision.load();
                    auto endpoint = openEndpoint(enumerator.Get());
                    ++epoch; source->reconfigure(endpoint->format->nSamplesPerSec);
                    rate = endpoint->format->nSamplesPerSec; error = S_OK;
                    bool started = false;
                    std::array<float, 2048> left{}, right{};
                    while (!stop) {
                        if (deviceRevision.load() != revision) throw AudioError{AUDCLNT_E_DEVICE_INVALIDATED};
                        processCommands(*source, wantedPlaying, fading, timeline, epoch, played);
                        UINT32 padding = 0;
                        checked(endpoint->client->GetCurrentPadding(&padding));
                        auto available = endpoint->bufferFrames - std::min(padding, endpoint->bufferFrames);
                        while (available) {
                            const auto count = std::min<UINT32>(available, 2048);
                            BYTE* buffer = nullptr;
                            checked(endpoint->renderer->GetBuffer(count, &buffer));
                            if (!source->render(left.data(), right.data(), count)) {
                                endpoint->renderer->ReleaseBuffer(count, AUDCLNT_BUFFERFLAGS_SILENT);
                                throw AudioError{E_FAIL};
                            }
                            const auto timing = source->timing();
                            convert(*endpoint, buffer, left.data(), right.data(), count);
                            checked(endpoint->renderer->ReleaseBuffer(count, 0));
                            const double step = 32000.0 / endpoint->format->nSamplesPerSec;
                            if (timing.musicFrames && !timeline.append({epoch, submitted,
                                submitted + timing.musicFrames, source->generation(), timing.sourceBegin, step})) throw AudioError{E_UNEXPECTED};
                            if (timing.musicFrames < count && !timeline.append({epoch,
                                submitted + timing.musicFrames, submitted + count, source->generation(), timing.sourceEnd, 0})) throw AudioError{E_UNEXPECTED};
                            submitted += count; available -= count;
                        }
                        if (!started) { checked(endpoint->client->Start()); started = true; }
                        UINT64 clock = 0, qpc = 0;
                        if (endpoint->clock->GetPosition(&clock, &qpc) == S_OK && submitted) {
                            played = std::clamp(static_cast<double>(clock) * endpoint->format->nSamplesPerSec /
                                static_cast<double>(endpoint->frequency), 0.0, static_cast<double>(submitted));
                            const auto sample = std::min(played, std::nextafter(static_cast<double>(submitted), 0.0));
                            if (const auto segment = timeline.segmentAt(epoch, sample)) {
                                if (auto* anchor = anchors.producer_slot()) {
                                    *anchor = {epoch, qpc, segment->generation, endpoint->format->nSamplesPerSec, source->drops(),
                                        segment->sourceBegin + (sample - static_cast<double>(segment->outputBegin)) * segment->sourceStep,
                                        segment->sourceStep, static_cast<double>(segment->outputEnd) - sample};
                                    anchor->periodFrames = endpoint->periodFrames; anchor->bufferFrames = endpoint->bufferFrames;
                                    anchor->channels = endpoint->format->nChannels; anchor->bits = endpoint->validBits; anchor->floating = endpoint->floating;
                                    anchors.publish();
                                }
                            }
                            timeline.retireBefore(epoch, played);
                        }
                        HANDLE waits[] = {wake, endpoint->event};
                        const auto waited = WaitForMultipleObjects(2, waits, FALSE, 1000);
                        if (waited == WAIT_FAILED) throw AudioError{HRESULT_FROM_WIN32(GetLastError())};
                    }
                } catch (const AudioError& failure) { error = failure.code; rate = 0; }
                catch (...) { error = E_OUTOFMEMORY; rate = 0; }
                if (!stop) {
                    processCommands(*source, wantedPlaying, fading, timeline, epoch, played);
                    WaitForSingleObject(wake, 1000);
                }
            }
        } catch (const AudioError& failure) { error = failure.code; }
        catch (...) { error = E_OUTOFMEMORY; }
        if (source) shutdownHandle = source->replace(nullptr, 0);
        if (enumerator && notification) enumerator->UnregisterEndpointNotificationCallback(notification.Get());
        notification.Reset(); enumerator.Reset(); source.reset();
        if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
        CoUninitialize();
    }
};
AudioEngine::AudioEngine() : impl_(std::make_unique<Impl>()) {}
AudioEngine::~AudioEngine() = default;
bool AudioEngine::replace(spc_native_instance* instance, uint32_t generation) {
    if (!instance || generation <= impl_->lastEnqueuedGeneration) return false;
    if (!impl_->push({Impl::Kind::Replace, instance, generation})) return false;
    impl_->lastEnqueuedGeneration = generation; return true;
}
bool AudioEngine::setPlaying(bool playing) { return impl_->push({Impl::Kind::Play, nullptr, playing ? 1u : 0u}); }
bool AudioEngine::setVolume(float volume) {
    return std::isfinite(volume) && volume >= 0 && volume <= 1 &&
        impl_->push({Impl::Kind::Volume, nullptr, 0, 0, volume});
}
bool AudioEngine::setCaptureRate(uint32_t n, uint32_t d) {
    return n && d && n <= 32000ull * d && impl_->push({Impl::Kind::Rate, nullptr, n, d});
}
bool AudioEngine::popRetired(spc_native_instance*& instance) {
    const auto* slot = impl_->retired.consumer_slot(); if (!slot) return false;
    instance = *slot; impl_->retired.consume(); return true;
}
bool AudioEngine::popAnchor(ClockAnchor& anchor) {
    const auto* slot = impl_->anchors.consumer_slot(); if (!slot) return false;
    anchor = *slot; impl_->anchors.consume(); return true;
}
CaptureQueue& AudioEngine::captures() noexcept { return *impl_->captures; }
unsigned AudioEngine::sampleRate() const noexcept { return impl_->rate.load(); }
long AudioEngine::lastError() const noexcept { return impl_->error.load(); }
}
