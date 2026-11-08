#pragma once
#include "model/Metrics.h"
#include <vector>
namespace visual_spc {
void referenceMapInto(const HistoryRecord&, const HistoryRecord*,
    const std::array<uint8_t, 24576>&, const std::array<uint8_t, 65536>&,
    const std::vector<float>&, const ViewConfig&, unsigned, bool, std::vector<uint32_t>&);
std::vector<uint32_t> referenceMap(const HistoryRecord&, const HistoryRecord*,
    const std::array<uint8_t, 24576>& access, const std::array<uint8_t, 65536>& persistence,
    const std::vector<float>& entropy, const ViewConfig&, unsigned palette, bool persistenceEnabled);
}
