#include "About.h"
#include <Windows.h>
#include "imgui.h"
#include <stdexcept>
namespace visual_spc {
namespace {
std::string_view resource(unsigned id) {
    const auto module = GetModuleHandleW(nullptr);
    const auto found = FindResourceW(module, MAKEINTRESOURCEW(id), RT_RCDATA);
    if (!found) throw std::runtime_error("Embedded About resource is missing");
    const auto loaded = LoadResource(module, found);
    const auto* data = static_cast<const char*>(LockResource(loaded));
    const auto size = SizeofResource(module, found);
    if (!data || !size) throw std::runtime_error("Embedded About resource is empty");
    return {data, size};
}
}
std::array<AboutSection, 7> aboutSections() {
    return {{{"Usage", resource(201)}, {"Credits and third-party notices", resource(202)},
        {"Application license (MIT)", resource(203)}, {"snes_spc license (LGPL 2.1)", resource(204)},
        {"Dear ImGui license (MIT)", resource(205)}, {"nlohmann/json license (MIT)", resource(206)},
        {"Source and rebuilding", resource(208)}}};
}
std::string_view embeddedSource() { return resource(207); }
bool drawAbout() {
    ImGui::Text("Visual SPC Player %s", SPC_PLAYER_VERSION);
    ImGui::TextWrapped("SPC700 / S-DSP player and memory visualizer. Usage, credits, licenses, and complete matching source are included in this executable.");
    bool exportSource = false;
    for (const auto& section : aboutSections()) {
        if (!ImGui::CollapsingHeader(section.title)) continue;
        ImGui::PushTextWrapPos(0);
        ImGui::TextUnformatted(section.text.data(), section.text.data() + section.text.size());
        ImGui::PopTextWrapPos();
        if (section.title == std::string_view("Source and rebuilding"))
            exportSource = ImGui::Button("Export source ZIP");
        ImGui::Spacing();
    }
    return exportSource;
}
}
