#include "render/SpectrumReference.h"
#include "model/SpectrumColors.h"
#include "../vendor/json/json.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#ifdef _WIN32
#include <Windows.h>
#ifdef _MSC_VER
#include <intrin.h>
#endif
#endif

using namespace visual_spc;
namespace {
using Clock = std::chrono::steady_clock;
using Json = nlohmann::json;
double elapsed(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); }
double percentile(std::vector<double> values, double fraction) {
    std::sort(values.begin(), values.end());
    return values.empty() ? 0 : values[static_cast<size_t>((values.size() - 1) * fraction)];
}
struct Metrics { double filterBuildMs = 0, rasterMs = 0; size_t filterBuilds = 0, occupiedPixels = 0; };

// Deliberately retain the former UI's map of cumulative frequency prefixes and
// full output reconstruction. This measures that algorithm, not the safer oracle.
class LegacyCpuImage {
    const std::deque<SpectrumRow>& rows_;
    std::map<uint64_t, std::vector<double>> filtered_;
    const std::vector<double>& filteredAt(size_t endpoint, const SpectrumReferenceConfig& config, Metrics& metrics) {
        const auto frame = rows_[endpoint].nativeFrame;
        if (const auto found = filtered_.find(frame); found != filtered_.end()) return found->second;
        const auto start = Clock::now();
        const unsigned bins = config.fftSize / 2 + 1;
        std::vector<double> result(bins + 1);
        const unsigned radius = config.temporal ? config.temporalMs * 32 / config.hopSize : 0;
        const unsigned step = std::max(1u, (radius + 7) / 8);
        double norm = 0;
        for (unsigned age = 0; age <= radius && age <= endpoint; age += step) {
            const auto& source = rows_[endpoint - age];
            if (frame - source.nativeFrame != uint64_t{age} * config.hopSize) break;
            const double weight = config.temporal ? std::exp(-double(frame - source.nativeFrame) /
                (std::max(1u, config.temporalMs) * 32.0)) : 1;
            norm += weight;
            const auto& values = config.difference ? source.difference : source.power;
            for (unsigned bin = 0; bin < bins; ++bin) result[bin + 1] += values[bin] * weight;
        }
        for (unsigned bin = 1; bin <= bins; ++bin) result[bin] = result[bin] / std::max(1e-12, norm) + result[bin - 1];
        const auto& stored = filtered_.emplace(frame, std::move(result)).first->second;
        metrics.filterBuildMs += elapsed(start); ++metrics.filterBuilds;
        return stored;
    }
public:
    explicit LegacyCpuImage(const std::deque<SpectrumRow>& rows) : rows_(rows) {}
    size_t cacheEntries() const { return filtered_.size(); }
    size_t cachePayloadBytes() const {
        size_t result = 0;
        for (const auto& entry : filtered_) result += entry.second.capacity() * sizeof(double);
        return result;
    }
    std::vector<uint32_t> draw(const SpectrumReferenceConfig& config, Metrics& metrics) {
        const unsigned w = config.width, h = config.height, bins = config.fftSize / 2 + 1, last = bins - 1;
        std::vector<uint32_t> pixels(static_cast<size_t>(w) * h, SpectrumReferenceUnavailableColor);
        std::vector<unsigned> lows(w), highs(w);
        std::vector<double> fractions(w);
        const auto frequency = [&](double fraction) { return config.logarithmic ? 20 * std::pow(800.0, fraction) : 16000 * fraction; };
        for (unsigned x = 0; x < w; ++x) {
            lows[x] = std::min(last, static_cast<unsigned>(frequency(double(x) / w) * config.fftSize / 32000));
            highs[x] = std::clamp(static_cast<unsigned>(std::ceil(frequency(double(x + 1) / w) * config.fftSize / 32000)), lows[x] + 1, bins);
            if (config.sampling == 1) {
                const double bin = frequency((x + 0.5) / w) * config.fftSize / 32000;
                lows[x] = std::min(last, static_cast<unsigned>(std::floor(bin))); highs[x] = std::min(bins, lows[x] + 2);
                fractions[x] = bin - std::floor(bin);
            } else if (config.sampling != 2) {
                lows[x] = std::min(last, static_cast<unsigned>(frequency((x + 0.5) / w) * config.fftSize / 32000 + 0.5)); highs[x] = lows[x] + 1;
            }
        }
        const auto rasterStart = Clock::now();
        if (!rows_.empty() && rows_.back().generation == config.generation) for (unsigned y = 0; y < h; ++y) {
            const double end = config.mediaFrame - double(y) * config.seconds * 32000 / h;
            const double begin = end - config.seconds * 32000 / h;
            const auto upper = std::upper_bound(rows_.begin(), rows_.end(), end, [](double frame, const auto& row) { return frame < row.nativeFrame; });
            if (upper == rows_.begin()) continue;
            const auto latest = std::prev(upper);
            const double phase = config.sampling == 1 && upper != rows_.end() && upper->nativeFrame <= config.mediaFrame &&
                upper->nativeFrame - latest->nativeFrame == config.hopSize ? std::clamp((end - latest->nativeFrame) / config.hopSize, 0.0, 1.0) : 0;
            if (end - latest->nativeFrame > config.hopSize * 2) continue;
            const size_t endpoint = static_cast<size_t>(latest - rows_.begin());
            std::vector<double> prefix = filteredAt(endpoint, config, metrics);
            double norm = 1;
            if (config.sampling == 2) {
                auto first = latest;
                while (first != rows_.begin() && std::prev(first)->nativeFrame >= begin && first->nativeFrame - std::prev(first)->nativeFrame == config.hopSize) --first;
                for (auto index = first; index != latest; ++index) {
                    const auto& previous = filteredAt(static_cast<size_t>(index - rows_.begin()), config, metrics);
                    for (unsigned bin = 1; bin <= bins; ++bin) prefix[bin] += previous[bin];
                    ++norm;
                }
            }
            if (phase > 0) {
                const auto& following = filteredAt(endpoint + 1, config, metrics);
                for (unsigned bin = 1; bin <= bins; ++bin) prefix[bin] = (1 - phase) * prefix[bin] + phase * following[bin];
            }
            for (unsigned x = 0; x < w; ++x) {
                const unsigned low = lows[x], high = highs[x];
                const double power = config.sampling == 1 && high - low == 2 ?
                    (prefix[low + 1] - prefix[low]) * (1 - fractions[x]) + (prefix[low + 2] - prefix[low + 1]) * fractions[x] : (prefix[high] - prefix[low]) / (high - low);
                const double db = 10 * std::log10(std::max(1e-12, power / std::max(1e-12, norm)));
                const unsigned level = static_cast<unsigned>(std::clamp((db - config.floorDb) / std::max(1.0f, config.ceilingDb - config.floorDb) * 255, 0.0, 255.0));
                pixels[static_cast<size_t>(y) * w + x] = spectrumColor(level, config.difference ? 2 : config.palette);
            }
            metrics.occupiedPixels += w;
        }
        metrics.rasterMs = elapsed(rasterStart);
        return pixels;
    }
};
std::deque<SpectrumRow> syntheticRows(const SpectrumReferenceConfig& config, double seconds) {
    const unsigned count = std::max(1u, static_cast<unsigned>(std::ceil(seconds * 32000 / config.hopSize)));
    const unsigned bins = config.fftSize / 2 + 1;
    const uint64_t newest = static_cast<uint64_t>(config.mediaFrame);
    std::deque<SpectrumRow> rows;
    for (unsigned index = 0; index < count; ++index) {
        rows.emplace_back(); auto& row = rows.back();
        row.generation = config.generation;
        row.nativeFrame = newest - uint64_t{count - 1 - index} * config.hopSize;
        row.power.resize(bins); row.difference.resize(bins);
        for (unsigned bin = 0; bin < bins; ++bin) {
            // Reproducible moving peaks, quiet bins and stereo difference, without an FFT or SPC.
            const unsigned phase = (bin * 17 + index * 13) % 257;
            const float power = static_cast<float>(1e-12 + double(phase * phase) / (256.0 * 256.0));
            row.power[bin] = bin % 31 == 0 ? 1e-12f : power;
            row.difference[bin] = bin % 11 == 0 ? 0 : power * static_cast<float>((bin + index) % 17) / 64;
        }
    }
    return rows;
}
Json hardware() {
    Json result{{"logicalProcessors", std::thread::hardware_concurrency()}, {"architecture", sizeof(void*) == 8 ? "64-bit" : "32-bit"}};
#ifdef _WIN32
    result["os"] = "Windows";
    result["logicalProcessors"] = GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
    MEMORYSTATUSEX memory{}; memory.dwLength = sizeof(memory);
    if (GlobalMemoryStatusEx(&memory)) result["physicalMemoryBytes"] = memory.ullTotalPhys;
#if defined(_MSC_VER) && (defined(_M_X64) || defined(_M_IX86))
    int registers[4]{}; __cpuid(registers, static_cast<int>(0x80000000u));
    if (static_cast<unsigned>(registers[0]) >= 0x80000004u) {
        std::array<char, 49> brand{};
        for (unsigned index = 0; index < 3; ++index) {
            __cpuid(registers, static_cast<int>(0x80000002u + index));
            std::memcpy(brand.data() + index * 16, registers, 16);
        }
        result["cpu"] = std::string(brand.data());
    }
#endif
#else
    result["os"] = "non-Windows diagnostic build";
#endif
    return result;
}
std::vector<double> numberList(const std::string& argument) {
    std::vector<double> result;
    size_t begin = 0;
    do {
        const auto end = argument.find(',', begin);
        const auto token = argument.substr(begin, end == std::string::npos ? end : end - begin);
        size_t consumed = 0; const double value = std::stod(token, &consumed);
        if (consumed != token.size() || !std::isfinite(value) || value <= 0 || value > 10) throw std::invalid_argument("Seconds must be in (0,10]");
        result.push_back(value);
        if (end == std::string::npos) break;
        begin = end + 1;
    } while (begin <= argument.size());
    return result;
}
unsigned unsignedValue(const std::string& value, unsigned minimum, unsigned maximum) {
    size_t consumed = 0; const auto parsed = std::stoul(value, &consumed);
    if (consumed != value.size() || parsed < minimum || parsed > maximum) throw std::invalid_argument("Unsigned argument out of range");
    return static_cast<unsigned>(parsed);
}
uint64_t checksum(const std::vector<uint32_t>& pixels) {
    uint64_t result = 1469598103934665603ull;
    for (const auto pixel : pixels) { result ^= pixel; result *= 1099511628211ull; }
    return result;
}
struct AnalysisObservation { size_t rows = 0; double powerChecksum = 0; };
void observeAnalysis(void* context, const SpectrumFrameView& row) noexcept {
    auto& observation = *static_cast<AnalysisObservation*>(context);
    ++observation.rows;
    observation.powerChecksum += row.power[0] + row.power[row.power.size() / 2] + row.difference.back();
}
std::vector<SpectrumPacket> analysisInput() {
    std::vector<SpectrumPacket> packets;
    for (unsigned frame = 0; frame < 32000; frame += 512) {
        packets.emplace_back(); auto& packet = packets.back();
        packet.generation = 1; packet.nativeFrame = frame;
        packet.frameCount = std::min(512u, 32000 - frame);
        for (unsigned index = 0; index < packet.frameCount; ++index) {
            const uint64_t position = frame + index;
            packet.pcm[index * 2] = static_cast<int16_t>(static_cast<int>((position * 109 + position / 97) % 65535) - 32767);
            packet.pcm[index * 2 + 1] = static_cast<int16_t>(static_cast<int>((position * 113 + position / 89) % 65535) - 32767);
        }
    }
    return packets;
}
}
int main(int argc, char** argv) {
    try {
        SpectrumReferenceConfig config;
        config.sampling = 1; config.temporal = true; config.temporalMs = 25;
        config.generation = 1; config.mediaFrame = 90 * 32000;
        std::vector<double> windows{0.5, 2, 5, 10};
        std::optional<std::vector<double>> histories;
        std::vector<std::pair<unsigned, unsigned>> dimensions{{1920, 1080}, {3840, 2160}};
        unsigned samples = 5, warmup = 1, width = 0, height = 0;
        double budgetSeconds = 30, refreshTarget = 60;
        bool measureAnalysis = false, analysisOnly = false;
        std::string output;
        for (int index = 1; index < argc; ++index) {
            const std::string argument = argv[index];
            const auto value = [&]() -> std::string { if (++index == argc) throw std::invalid_argument("Missing argument for " + argument); return argv[index]; };
            if (argument == "--help") {
                std::cout << "CPU spectrogram baseline (synthetic rows; no audio, GPU, upload or Present).\n"
                    "--quick --samples N --warmup N --budget-seconds N --width N --height N\n"
                    "--seconds 0.5,2,5,10 --history-seconds 0.5,2,5,10 --fft 1024|2048|4096\n"
                    "--hop 64|128|256|512 --sampling nearest|smooth|area --temporal-ms 0..200\n"
                    "--log --difference --palette 0..2 --refresh-target HZ --output .local/file.json\n";
                std::cout << "--analysis (also measure KISS FFT packing/FFT/power for 1024/2048/4096, hop64/256)\n"
                    "--analysis-only (skip the image baseline)\n";
                return 0;
            } else if (argument == "--quick") { samples = 1; warmup = 0; budgetSeconds = 15; }
            else if (argument == "--samples") samples = unsignedValue(value(), 1, 1000);
            else if (argument == "--warmup") warmup = unsignedValue(value(), 0, 100);
            else if (argument == "--width") width = unsignedValue(value(), 1, 7680);
            else if (argument == "--height") height = unsignedValue(value(), 1, 4320);
            else if (argument == "--fft") config.fftSize = unsignedValue(value(), 1024, 4096);
            else if (argument == "--hop") config.hopSize = unsignedValue(value(), 64, 512);
            else if (argument == "--seconds") windows = numberList(value());
            else if (argument == "--history-seconds") histories = numberList(value());
            else if (argument == "--budget-seconds") budgetSeconds = std::stod(value());
            else if (argument == "--refresh-target") refreshTarget = std::stod(value());
            else if (argument == "--temporal-ms") { config.temporalMs = unsignedValue(value(), 0, 200); config.temporal = config.temporalMs != 0; }
            else if (argument == "--palette") config.palette = unsignedValue(value(), 0, 2);
            else if (argument == "--log") config.logarithmic = true;
            else if (argument == "--difference") config.difference = true;
            else if (argument == "--analysis") measureAnalysis = true;
            else if (argument == "--analysis-only") { measureAnalysis = true; analysisOnly = true; }
            else if (argument == "--output") output = value();
            else if (argument == "--sampling") {
                const auto mode = value();
                if (mode == "nearest" || mode == "0") config.sampling = 0;
                else if (mode == "smooth" || mode == "1") config.sampling = 1;
                else if (mode == "area" || mode == "2") config.sampling = 2;
                else throw std::invalid_argument("Unknown sampling mode");
            } else throw std::invalid_argument("Unknown argument: " + argument);
        }
        if ((config.fftSize != 1024 && config.fftSize != 2048 && config.fftSize != 4096) ||
            (config.hopSize != 64 && config.hopSize != 128 && config.hopSize != 256 && config.hopSize != 512))
            throw std::invalid_argument("Unsupported FFT/hop");
        if (!std::isfinite(budgetSeconds) || budgetSeconds <= 0 || budgetSeconds > 3600 ||
            !std::isfinite(refreshTarget) || refreshTarget <= 0 || refreshTarget > 1000)
            throw std::invalid_argument("Invalid time budget or refresh target");
        if (width || height) {
            if (!width || !height) throw std::invalid_argument("Specify both --width and --height");
            dimensions = {{width, height}};
        }
        Json report{{"schema", 1}, {"algorithm", "legacy-full-history-cpu-prefix-raster"}, {"hardware", hardware()},
            {"measurement", "CPU image allocation, frequency planning, filtered-prefix cache, full raster and palette conversion; excludes audio, FFT, GPU, upload and Present"},
            {"syntheticInput", true}, {"samplesRequested", samples}, {"warmupRequested", warmup}, {"budgetSeconds", budgetSeconds},
            {"refreshTargetHz", refreshTarget}, {"results", Json::array()}};
#ifdef NDEBUG
        report["build"] = "Release";
#else
        report["build"] = "Debug";
#endif
#ifdef _MSC_FULL_VER
        report["msvcFullVersion"] = _MSC_FULL_VER;
#endif
#ifdef SPC_HAS_IPO
        report["ipo"] = SPC_HAS_IPO != 0;
#else
        report["ipo"] = nullptr;
#endif
        const auto totalStart = Clock::now();
        bool budgetExhausted = false;
        if (analysisOnly) dimensions.clear();
        for (const auto& [plotWidth, plotHeight] : dimensions) for (const double seconds : windows) {
            const auto retained = histories.value_or(std::vector<double>{seconds});
            for (const double historySeconds : retained) {
                if (elapsed(totalStart) >= budgetSeconds * 1000) { budgetExhausted = true; break; }
                config.width = plotWidth; config.height = plotHeight; config.seconds = seconds;
                const auto rows = syntheticRows(config, historySeconds);
                LegacyCpuImage baseline(rows);
                Metrics coldMetrics;
                const auto coldStart = Clock::now();
                auto pixels = baseline.draw(config, coldMetrics);
                const double coldMs = elapsed(coldStart);
                std::vector<double> times, filterTimes, rasterTimes;
                size_t missedDeadlines = 0;
                for (unsigned sample = 0; sample < warmup + samples; ++sample) {
                    if (elapsed(totalStart) >= budgetSeconds * 1000) { budgetExhausted = true; break; }
                    Metrics metrics; const auto start = Clock::now();
                    pixels = baseline.draw(config, metrics);
                    const double cpuMs = elapsed(start);
                    if (sample < warmup) continue;
                    times.push_back(cpuMs); filterTimes.push_back(metrics.filterBuildMs);
                    rasterTimes.push_back(metrics.rasterMs - metrics.filterBuildMs);
                    missedDeadlines += cpuMs > 1000 / refreshTarget;
                }
                const size_t rowPayload = rows.size() * (config.fftSize / 2 + 1) * 2 * sizeof(float);
                report["results"].push_back({{"width", config.width}, {"height", config.height}, {"seconds", seconds},
                    {"historySeconds", historySeconds}, {"fftSize", config.fftSize}, {"hopSize", config.hopSize},
                    {"sampling", config.sampling}, {"temporal", config.temporal}, {"temporalMs", config.temporalMs},
                    {"logarithmic", config.logarithmic}, {"difference", config.difference}, {"palette", config.palette},
                    {"floorDb", config.floorDb}, {"ceilingDb", config.ceilingDb}, {"mediaFrame", config.mediaFrame},
                    {"rows", rows.size()}, {"rowPayloadBytes", rowPayload}, {"outputBytes", pixels.size() * sizeof(uint32_t)},
                    {"occupiedPixelFraction", double(coldMetrics.occupiedPixels) / pixels.size()},
                    {"coldImageCpuMs", coldMs}, {"coldFilterBuildMs", coldMetrics.filterBuildMs}, {"coldFilterBuilds", coldMetrics.filterBuilds},
                    {"cacheEntries", baseline.cacheEntries()}, {"cachePayloadBytes", baseline.cachePayloadBytes()},
                    {"samples", times.size()}, {"cpuMsP50", percentile(times, 0.5)}, {"cpuMsP95", percentile(times, 0.95)},
                    {"cpuMsP99", percentile(times, 0.99)}, {"cpuMsMax", times.empty() ? 0 : *std::max_element(times.begin(), times.end())},
                    {"filterBuildMsP50", percentile(filterTimes, 0.5)}, {"rasterExcludingFilterBuildMsP50", percentile(rasterTimes, 0.5)},
                    {"cpuImageMissedDeadlines", missedDeadlines}, {"pixelChecksum", checksum(pixels)}});
            }
        }
        if (measureAnalysis) {
            report["analysis"] = Json::array();
            const auto packets = analysisInput(); // PCM generation stays outside the measured interval.
            for (const unsigned fftSize : {1024u, 2048u, 4096u}) for (const unsigned hopSize : {64u, 256u}) {
                std::vector<double> times, setupTimes;
                AnalysisObservation observation;
                for (unsigned sample = 0; sample < warmup + samples; ++sample) {
                    if (elapsed(totalStart) >= budgetSeconds * 1000) { budgetExhausted = true; break; }
                    observation = {};
                    const auto setupStart = Clock::now();
                    Spectrogram analyser(observeAnalysis, &observation);
                    if (!analyser.configure(fftSize, hopSize)) throw std::runtime_error("Analysis configuration rejected");
                    const double setupMs = elapsed(setupStart);
                    const auto start = Clock::now();
                    for (const auto& packet : packets) if (!analyser.ingest(packet)) throw std::runtime_error("Synthetic analysis input rejected");
                    const double cpuMs = elapsed(start);
                    if (sample < warmup) continue;
                    times.push_back(cpuMs); setupTimes.push_back(setupMs);
                }
                report["analysis"].push_back({{"fftSize", fftSize}, {"hopSize", hopSize}, {"inputFrames", 32000},
                    {"rows", observation.rows}, {"samples", times.size()}, {"cpuMsP50", percentile(times, 0.5)},
                    {"cpuMsP95", percentile(times, 0.95)}, {"cpuMsP99", percentile(times, 0.99)},
                    {"cpuMsPerRowP50", observation.rows ? percentile(times, 0.5) / observation.rows : 0},
                    {"setupMsP50", percentile(setupTimes, 0.5)}, {"powerChecksum", observation.powerChecksum},
                    {"measurement", "Streaming input packing, stereo KISS FFT, calibrated power and difference; no retained history, worker queue, GPU or SPC"}});
            }
        }
        report["elapsedSeconds"] = elapsed(totalStart) / 1000;
        report["budgetExhausted"] = budgetExhausted;
        const auto serialized = report.dump(2);
        if (!output.empty()) {
            std::ofstream file(output);
            if (!file || !(file << serialized << '\n')) throw std::runtime_error("Cannot write benchmark output: " + output);
        }
        std::cout << serialized << '\n';
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
