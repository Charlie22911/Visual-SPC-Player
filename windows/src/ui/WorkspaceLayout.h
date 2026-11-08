#pragma once
#include "imgui.h"
#include <functional>
#include <string>

namespace visual_spc {
inline constexpr ImGuiWindowFlags fixedRegionFlags = ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse;
struct SidebarState { bool open = true, pinned = false; };
struct FooterText { std::string inspection, legend, live, performance; };
struct WorkspaceGeometry {
    ImVec2 playerPosition, playerSize, libraryPosition, librarySize, tabPosition, tabSize, footerPosition, footerSize;
};
WorkspaceGeometry workspaceGeometry(ImVec2 origin, ImVec2 size, float footerHeight, float dpi, SidebarState);
// Draw player first, then the overlaid library/tab. Only a pinned, open library
// reserves width. Callbacks inherit independent child clipping/input regions.
bool drawWorkspace(SidebarState&, const std::function<void()>& player,
    const std::function<void()>& library, const std::function<FooterText()>& footer);

class FlowToolbar {
    float right_;
    bool first_ = true;
public:
    FlowToolbar() : right_(ImGui::GetCursorScreenPos().x + ImGui::GetContentRegionAvail().x) {}
    void next(float width) {
        if (!first_ && ImGui::GetItemRectMax().x + ImGui::GetStyle().ItemSpacing.x + width <= right_)
            ImGui::SameLine();
        first_ = false;
    }
    static float buttonWidth(const char* label) {
        return ImGui::CalcTextSize(label, nullptr, true).x + ImGui::GetStyle().FramePadding.x * 2;
    }
    static float toggleWidth(const char* label) {
        return ImGui::GetFrameHeight() + ImGui::GetStyle().ItemInnerSpacing.x + ImGui::CalcTextSize(label).x;
    }
};
}
