#include "ReferenceRenderer.h"
#include "model/PaletteTables.h"
#include <algorithm>
#include <cmath>
namespace visual_spc {
namespace {
struct RenderColors {
    uint32_t activityByte[5][8][256]{}, dataByte[5][8][256]{};
    uint32_t activityBit[5][8][2]{}, dataBit[5][8][2]{};
    static uint32_t blend(uint32_t background, uint32_t foreground, unsigned kind, bool underlay) {
        uint32_t result = 0xff000000u;
        for (unsigned channel = 0; channel < 3; ++channel) {
            const double bg = (background >> (channel * 8)) & 255, fg = (foreground >> (channel * 8)) & 255;
            const double mixed = underlay ? bg * 0.35 * (kind ? 0.08 : 1) + (kind ? fg * 0.92 : 0) :
                kind ? bg * 0.55 + fg * 0.45 : bg;
            const auto value = static_cast<uint32_t>(underlay ? std::floor(mixed + 0.5) : std::nearbyint(mixed));
            result |= value << (channel * 8);
        }
        return result;
    }
    RenderColors() {
        for (unsigned palette = 0; palette < 5; ++palette) for (unsigned kind = 0; kind < 8; ++kind) {
            const auto foreground = paletteTables[palette][3][kind];
            for (unsigned value = 0; value < 256; ++value) {
                activityByte[palette][kind][value] = blend(paletteTables[palette][0][value], foreground, kind, true);
                dataByte[palette][kind][value] = blend(paletteTables[palette][0][value], foreground, kind, false);
            }
            for (unsigned value = 0; value < 2; ++value) {
                activityBit[palette][kind][value] = blend(paletteTables[palette][1][value * 255], foreground, kind, true);
                dataBit[palette][kind][value] = blend(paletteTables[palette][1][value * 255], foreground, kind, false);
            }
        }
    }
};
}
void referenceMapInto(const HistoryRecord& record, const HistoryRecord* previous,
    const std::array<uint8_t, 24576>& access, const std::array<uint8_t, 65536>& persistence,
    const std::vector<float>& entropy, const ViewConfig& config, unsigned palette, bool persistent, std::vector<uint32_t>& pixels) {
    const unsigned width = config.bits ? 1024 : 256, height = config.bits ? 512 : 256;
    pixels.resize(width * height);
    static const RenderColors colors;
    for (unsigned a = 0; a < 65536; ++a) {
        const auto byte = record.ram[a];
        const auto kind = ((access[a >> 3] >> (a & 7)) & 1) |
            (((access[8192 + (a >> 3)] >> (a & 7)) & 1) << 1) |
            (((access[16384 + (a >> 3)] >> (a & 7)) & 1) << 2);
        for (unsigned lane = 0; lane < (config.bits ? 8u : 1u); ++lane) {
        const unsigned x = config.bits ? (a & 255) * 4 + (lane & 3) : a & 255;
        const unsigned y = config.bits ? (a >> 8) * 2 + (lane >> 2) : a >> 8;
        uint32_t color = 0;
        unsigned overlay = 0;
        if (config.measurement == Measurement::Entropy) {
            const auto metric = entropy[lane * 256 + (a >> 8)] / (config.bits ? 1 : 8);
            color = paletteTables[palette][2][std::clamp(static_cast<int>(std::floor(metric * 255 + 0.5f)), 0, 255)];
        } else if (config.measurement == Measurement::Data) {
            if (config.changesOnly && !previous) color = paletteTables[palette][2][a & 8 ? 20 : 35];
            else {
                const auto value = config.changesOnly ? byte ^ previous->ram[a] : byte;
                if (persistent && !config.changesOnly) overlay = persistence[a];
                color = config.bits ? colors.dataBit[palette][overlay][(value >> (7 - lane)) & 1] :
                    colors.dataByte[palette][overlay][value];
            }
        } else {
            const auto activity = persistent && !config.underlay ? persistence[a] : kind;
            color = paletteTables[palette][3][activity];
            if (config.underlay) {
                color = config.bits ? colors.activityBit[palette][activity][(byte >> (7 - lane)) & 1] :
                    colors.activityByte[palette][activity][byte];
            }
        }
        pixels[y * width + x] = color;
    }
    }
}
std::vector<uint32_t> referenceMap(const HistoryRecord& record, const HistoryRecord* previous,
    const std::array<uint8_t, 24576>& access, const std::array<uint8_t, 65536>& persistence,
    const std::vector<float>& entropy, const ViewConfig& config, unsigned palette, bool persistent) {
    std::vector<uint32_t> pixels;
    referenceMapInto(record, previous, access, persistence, entropy, config, palette, persistent, pixels);
    return pixels;
}
}
