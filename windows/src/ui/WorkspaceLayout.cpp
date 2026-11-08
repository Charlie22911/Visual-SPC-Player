#include "WorkspaceLayout.h"
#include <algorithm>
#include <cmath>

namespace visual_spc {
WorkspaceGeometry workspaceGeometry(ImVec2 origin, ImVec2 size, float footerHeight, float dpi, SidebarState sidebar) {
    const float tab = 24 * dpi, gap = 8 * dpi;
    const float width = std::max(1.0f, size.x), height = std::max(1.0f, size.y);
    const float footer = std::min(height, footerHeight);
    const float body = std::max(1.0f, height - footer - gap);
    const float libraryWidth = std::min(280 * dpi, std::max(tab, width - tab - gap));
    const float reserved = std::min(width - 1, sidebar.open && sidebar.pinned ? libraryWidth + tab + gap : tab + gap);
    return {{origin.x + reserved, origin.y}, {width - reserved, body}, origin, {libraryWidth, body},
        {origin.x + (sidebar.open ? libraryWidth - 1 : 0), origin.y + 12 * dpi}, {tab, 58 * dpi},
        {origin.x, origin.y + height - footer}, {width, footer}};
}
namespace {
std::string fitText(const std::string& text, float width) {
    if (ImGui::CalcTextSize(text.c_str()).x <= width) return text;
    const float ellipsis = ImGui::CalcTextSize("...").x;
    if (width < ellipsis) return {};
    size_t end = text.size();
    while (end && ImGui::CalcTextSize(text.data(), text.data() + end).x + ellipsis > width) {
        --end;
        while (end && (static_cast<unsigned char>(text[end]) & 0xc0) == 0x80) --end;
    }
    return text.substr(0, end) + "...";
}
void footerCell(const std::string& text, ImVec2 position, float width, bool right, ImU32 color) {
    if (width <= 0) return;
    const auto shown = fitText(text, width);
    const auto end = ImVec2(position.x + width, position.y + ImGui::GetTextLineHeight());
    auto* draw = ImGui::GetWindowDrawList();
    draw->PushClipRect(position, end, true);
    draw->AddText(ImVec2(position.x + (right ? width - ImGui::CalcTextSize(shown.c_str()).x : 0), position.y), color, shown.c_str());
    draw->PopClipRect();
    if (!text.empty() && ImGui::IsMouseHoveringRect(position, end)) ImGui::SetTooltip("%s", text.c_str());
}
void drawFooter(const WorkspaceGeometry& layout, const FooterText& text) {
    const auto& style = ImGui::GetStyle();
    auto* draw = ImGui::GetWindowDrawList();
    const auto p = layout.footerPosition;
    draw->AddLine(p, ImVec2(p.x + layout.footerSize.x, p.y), ImGui::GetColorU32(ImGuiCol_Border));
    const float pad = 6 * style.FontScaleDpi, gap = 18 * style.FontScaleDpi;
    const float wanted = std::max(ImGui::CalcTextSize(text.live.c_str()).x, ImGui::CalcTextSize(text.performance.c_str()).x);
    const float rightWidth = std::min(wanted, layout.footerSize.x * 0.55f);
    const float leftWidth = std::max(0.0f, layout.footerSize.x - rightWidth - gap);
    const float rightX = p.x + layout.footerSize.x - rightWidth;
    footerCell(text.inspection, ImVec2(p.x, p.y + pad), leftWidth, false, ImGui::GetColorU32(ImGuiCol_TextDisabled));
    footerCell(text.legend, ImVec2(p.x, p.y + pad + ImGui::GetTextLineHeightWithSpacing()), leftWidth, false, ImGui::GetColorU32(ImGuiCol_TextDisabled));
    footerCell(text.live, ImVec2(rightX, p.y + pad), rightWidth, true, IM_COL32(140, 255, 225, 255));
    footerCell(text.performance, ImVec2(rightX, p.y + pad + ImGui::GetTextLineHeightWithSpacing()), rightWidth, true, ImGui::GetColorU32(ImGuiCol_TextDisabled));
    ImGui::SetCursorScreenPos(p); ImGui::Dummy(layout.footerSize);
}
bool pinButton(bool pinned) {
    const float size = ImGui::GetFrameHeight();
    const auto p = ImGui::GetCursorScreenPos();
    const bool pressed = ImGui::Button("##Pin library", ImVec2(size, size));
    const auto center = ImVec2(p.x + size * 0.5f, p.y + size * 0.5f);
    auto transform = [&](float x, float y) {
        if (!pinned) { const float t = (x - y) * 0.7071f; y = (x + y) * 0.7071f; x = t; }
        return ImVec2(center.x + x * size, center.y + y * size);
    };
    auto* draw = ImGui::GetWindowDrawList();
    const auto color = pinned ? IM_COL32(140, 255, 225, 255) : ImGui::GetColorU32(ImGuiCol_Text);
    draw->AddLine(transform(-0.16f, -0.24f), transform(0.16f, -0.24f), color, 2);
    draw->AddLine(transform(-0.1f, -0.24f), transform(-0.13f, 0.02f), color, 2);
    draw->AddLine(transform(0.1f, -0.24f), transform(0.13f, 0.02f), color, 2);
    draw->AddLine(transform(-0.2f, 0.04f), transform(0.2f, 0.04f), color, 2);
    draw->AddLine(transform(0, 0.04f), transform(0, 0.3f), color, 2);
    if (ImGui::IsItemHovered()) ImGui::SetTooltip(pinned ? "Unpin library: float over the player" : "Pin library: reserve space beside the player");
    return pressed;
}
}
bool drawWorkspace(SidebarState& sidebar, const std::function<void()>& player,
    const std::function<void()>& library, const std::function<FooterText()>& footer) {
    const auto before = sidebar;
    const float dpi = ImGui::GetStyle().FontScaleDpi;
    const float footerHeight = 12 * dpi + ImGui::GetTextLineHeight() * 2 + ImGui::GetStyle().ItemSpacing.y;
    const auto layout = workspaceGeometry(ImGui::GetCursorScreenPos(), ImGui::GetContentRegionAvail(), footerHeight, dpi, sidebar);
    ImGui::SetCursorScreenPos(layout.playerPosition);
    if (ImGui::BeginChild("Player", layout.playerSize, 0, fixedRegionFlags)) player();
    ImGui::EndChild();
    if (sidebar.open) {
        ImGui::SetCursorScreenPos(layout.libraryPosition);
        ImGui::PushStyleVar(ImGuiStyleVar_ChildRounding, 0);
        if (ImGui::BeginChild("Library", layout.librarySize, ImGuiChildFlags_Borders, fixedRegionFlags)) {
            ImGui::AlignTextToFramePadding(); ImGui::TextUnformatted("Library");
            ImGui::SameLine(std::max(ImGui::GetCursorPosX(), ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - ImGui::GetFrameHeight()));
            if (pinButton(sidebar.pinned)) sidebar.pinned = !sidebar.pinned;
            library();
        }
        ImGui::EndChild(); ImGui::PopStyleVar();
    }
    ImGui::SetCursorScreenPos(layout.tabPosition);
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0, 0, 0, 0));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
    if (ImGui::BeginChild("Library border tab", layout.tabSize, 0, fixedRegionFlags)) {
        const auto p = ImGui::GetCursorScreenPos();
        ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0, 0, 0, 0));
        ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0, 0, 0, 0));
        ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0, 0, 0, 0));
        if (ImGui::Button("##Toggle library", layout.tabSize)) sidebar.open = !sidebar.open;
        ImGui::PopStyleColor(3);
        const float w = layout.tabSize.x, h = layout.tabSize.y, tip = 6 * dpi;
        const ImVec2 points[] = {p, {p.x + w - tip, p.y}, {p.x + w, p.y + tip},
            {p.x + w, p.y + h - tip}, {p.x + w - tip, p.y + h}, {p.x, p.y + h}};
        auto* draw = ImGui::GetWindowDrawList();
        draw->AddConvexPolyFilled(points, 6, ImGui::GetColorU32(ImGui::IsItemHovered() ? ImGuiCol_ButtonHovered : ImGuiCol_WindowBg));
        draw->AddPolyline(points, 6, ImGui::GetColorU32(ImGuiCol_Border), 1.0f, ImDrawFlags_None);
        const char* arrow = before.open ? "<" : ">";
        const auto text = ImGui::CalcTextSize(arrow);
        draw->AddText(ImVec2(p.x + (w - text.x) / 2, p.y + (h - text.y) / 2), ImGui::GetColorU32(ImGuiCol_Text), arrow);
        if (ImGui::IsItemHovered()) ImGui::SetTooltip(before.open ? "Collapse library" : "Expand library");
    }
    ImGui::EndChild(); ImGui::PopStyleVar(); ImGui::PopStyleColor();
    drawFooter(layout, footer());
    return before.open != sidebar.open || before.pinned != sidebar.pinned;
}
}
