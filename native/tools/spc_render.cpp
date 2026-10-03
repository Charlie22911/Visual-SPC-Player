#include "software_spc_backend.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace {
constexpr uint32_t kDefaultSeconds = 20;
constexpr size_t kBlockFrames = 256;

void write_u16(std::ostream &out, uint16_t value) {
    const char bytes[] = {
        static_cast<char>(value),
        static_cast<char>(value >> 8),
    };
    out.write(bytes, sizeof(bytes));
}

void write_u32(std::ostream &out, uint32_t value) {
    const char bytes[] = {
        static_cast<char>(value),
        static_cast<char>(value >> 8),
        static_cast<char>(value >> 16),
        static_cast<char>(value >> 24),
    };
    out.write(bytes, sizeof(bytes));
}

bool write_wav_header(std::ostream &out, uint32_t frames) {
    constexpr uint16_t channels = SOFTWARE_SPC_CHANNELS;
    constexpr uint16_t bits_per_sample = 16;
    constexpr uint16_t block_align = channels * bits_per_sample / 8;
    constexpr uint32_t byte_rate = SOFTWARE_SPC_SAMPLE_RATE * block_align;
    const uint32_t data_bytes = frames * block_align;

    out.write("RIFF", 4);
    write_u32(out, 36 + data_bytes);
    out.write("WAVEfmt ", 8);
    write_u32(out, 16);
    write_u16(out, 1);
    write_u16(out, channels);
    write_u32(out, SOFTWARE_SPC_SAMPLE_RATE);
    write_u32(out, byte_rate);
    write_u16(out, block_align);
    write_u16(out, bits_per_sample);
    out.write("data", 4);
    write_u32(out, data_bytes);
    return out.good();
}

bool parse_seconds(const char *text, uint32_t &seconds) {
    char *end = nullptr;
    const unsigned long value = std::strtoul(text, &end, 10);
    if (text == end || *end != '\0' || value == 0 || value > 3600) {
        return false;
    }
    seconds = static_cast<uint32_t>(value);
    return true;
}
} // namespace

int main(int argc, char **argv) {
    if (argc < 3 || argc > 5) {
        std::fprintf(stderr, "usage: spc_render input.spc output.wav [seconds] [activity]\n");
        return 2;
    }

    uint32_t seconds = kDefaultSeconds;
    if (argc >= 4 && !parse_seconds(argv[3], seconds)) {
        std::fprintf(stderr, "seconds must be an integer from 1 through 3600\n");
        return 2;
    }
    const bool activity_enabled = argc == 5 && std::strcmp(argv[4], "activity") == 0;
    if (argc == 5 && !activity_enabled) {
        std::fprintf(stderr, "final argument must be 'activity'\n");
        return 2;
    }

    std::ifstream input(argv[1], std::ios::binary);
    if (!input) {
        std::fprintf(stderr, "cannot open SPC: %s\n", argv[1]);
        return 1;
    }
    std::vector<uint8_t> image((std::istreambuf_iterator<char>(input)),
                               std::istreambuf_iterator<char>());
    if (input.bad()) {
        std::fprintf(stderr, "failed while reading SPC\n");
        return 1;
    }

    std::unique_ptr<software_spc_backend_t, decltype(&software_spc_destroy)> backend(
        software_spc_create(), software_spc_destroy);
    if (!backend) {
        std::fprintf(stderr, "cannot initialize SPC emulator\n");
        return 1;
    }
    if (const char *error = software_spc_load(backend.get(), image.data(), image.size(), 1)) {
        std::fprintf(stderr, "cannot load SPC: %s\n", error);
        return 1;
    }
    std::vector<uint8_t> activity_read(8192u);
    std::vector<uint8_t> activity_write(8192u);
    std::vector<uint8_t> activity_execute(8192u);
    if (activity_enabled) {
        software_spc_set_aram_visualizer(backend.get(), activity_read.data(), activity_write.data(),
                                         activity_execute.data());
    }

    const uint32_t total_frames = seconds * SOFTWARE_SPC_SAMPLE_RATE;
    std::ofstream output(argv[2], std::ios::binary | std::ios::trunc);
    if (!output || !write_wav_header(output, total_frames)) {
        std::fprintf(stderr, "cannot create WAV: %s\n", argv[2]);
        return 1;
    }

    std::vector<int16_t> samples(kBlockFrames * SOFTWARE_SPC_CHANNELS);
    uint64_t squared_sum = 0;
    uint32_t peak = 0;
    uint32_t frames_left = total_frames;
    while (frames_left != 0) {
        const size_t frames = std::min<size_t>(frames_left, kBlockFrames);
        if (const char *error = software_spc_render(backend.get(), samples.data(), frames)) {
            std::fprintf(stderr, "SPC render failed: %s\n", error);
            return 1;
        }
        const size_t sample_count = frames * SOFTWARE_SPC_CHANNELS;
        output.write(reinterpret_cast<const char *>(samples.data()),
                     static_cast<std::streamsize>(sample_count * sizeof(samples[0])));
        for (size_t i = 0; i < sample_count; ++i) {
            const int32_t value = samples[i];
            const uint32_t magnitude = static_cast<uint32_t>(value < 0 ? -value : value);
            peak = std::max(peak, magnitude);
            squared_sum += static_cast<uint64_t>(value * value);
        }
        frames_left -= static_cast<uint32_t>(frames);
    }
    output.close();
    if (!output) {
        std::fprintf(stderr, "failed while writing WAV\n");
        return 1;
    }

    const uint64_t sample_count = static_cast<uint64_t>(total_frames) * SOFTWARE_SPC_CHANNELS;
    const long double rms = std::sqrt(static_cast<long double>(squared_sum) / sample_count);
    std::printf("core=snes_spc@ec8ee2bbe30451614c1d02a83f7af1c97d497d45 "
                "rate=%d channels=%d frames=%u block_frames=%zu clear_echo=1 filter=0 "
                "activity=%u peak=%u rms=%.2Lf\n",
                SOFTWARE_SPC_SAMPLE_RATE, SOFTWARE_SPC_CHANNELS, total_frames, kBlockFrames,
                activity_enabled, peak, rms);
    return 0;
}
