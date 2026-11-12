#include "PlayerWidgets.h"
#include "WorkspaceLayout.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace visual_spc {
namespace {
constexpr std::array headers{"Voice", "L", "R", "Pitch", "BRR", "Source", "Envelope", "ADSR", "Gain", "ENVX", "OUTX", "Mode", "KON/KOFF/ENDX"};
uint16_t word(const uint8_t* p) { return static_cast<uint16_t>(p[0] | p[1] << 8); }
float widestDecimal(int first, int last) {
    float width = 0;
    for (int value = first; value <= last; ++value) {
        char text[16]; std::snprintf(text, sizeof(text), "%d", value);
        width = std::max(width, ImGui::CalcTextSize(text).x);
    }
    return width;
}
void textSlot(const std::string& text, float width, ImU32 color, bool framed = false) {
    const auto p = ImGui::GetCursorScreenPos();
    const float height = framed ? ImGui::GetFrameHeight() : ImGui::GetTextLineHeight();
    width = std::max(1.0f, width);
    ImGui::Dummy(ImVec2(width, height));
    const ImVec4 clip(p.x, p.y, p.x + width, p.y + height);
    const ImVec2 textPosition(p.x, p.y + (height - ImGui::GetTextLineHeight()) / 2);
    ImGui::GetWindowDrawList()->AddText(ImGui::GetFont(), ImGui::GetFontSize(), textPosition, color, text.c_str(), nullptr, 0, &clip);
    if (!text.empty() && ImGui::IsItemHovered()) ImGui::SetTooltip("%s", text.c_str());
}
void speakerSymbol(float volume) {
    const auto p = ImGui::GetCursorScreenPos();
    const float h = ImGui::GetFrameHeight(), w = h * 0.8f;
    ImGui::Dummy(ImVec2(w, h));
    auto* draw = ImGui::GetWindowDrawList();
    const ImU32 color = ImGui::GetColorU32(ImGuiCol_Text);
    const auto at = [&](float x, float y) { return ImVec2(p.x + w * x, p.y + h * y); };
    draw->AddRectFilled(at(0.05f, 0.4f), at(0.22f, 0.6f), color);
    const ImVec2 cone[] = {at(0.19f, 0.4f), at(0.47f, 0.24f), at(0.47f, 0.76f), at(0.19f, 0.6f)};
    draw->AddConvexPolyFilled(cone, 4, color);
    const float thickness = std::max(1.0f, ImGui::GetFontSize() * 0.08f);
    if (volume > 0) {
        for (float r : {0.23f, 0.4f}) {
            draw->PathArcTo(at(0.48f, 0.5f), w * r, -0.8f, 0.8f);
            draw->PathStroke(color, thickness, ImDrawFlags_None);
        }
    } else {
        draw->AddLine(at(0.65f, 0.4f), at(0.92f, 0.6f), color, thickness);
        draw->AddLine(at(0.65f, 0.6f), at(0.92f, 0.4f), color, thickness);
    }
    if (ImGui::IsItemHovered()) ImGui::SetTooltip("Volume");
}
}
std::array<float, 13> voiceColumnWidths() {
    // Recompute only when the active font/size changes, including both DPI and
    // independent font scaling. Value changes never enter this calculation.
    static ImGuiContext* context = nullptr;
    static ImFont* font = nullptr;
    static float fontSize = 0;
    static std::array<float, 13> cached{};
    if (context == ImGui::GetCurrentContext() && font == ImGui::GetFont() && fontSize == ImGui::GetFontSize()) return cached;
    context = ImGui::GetCurrentContext(); font = ImGui::GetFont(); fontSize = ImGui::GetFontSize();
    float hexDigit = 0;
    for (char digit : std::string("0123456789ABCDEF")) {
        const char text[] = {digit, 0}; hexDigit = std::max(hexDigit, ImGui::CalcTextSize(text).x);
    }
    const float dollar = ImGui::CalcTextSize("$").x;
    const float signedByte = widestDecimal(-128, 127), unsignedByte = widestDecimal(0, 255);
    const float mode = std::max({ImGui::CalcTextSize("Release").x, ImGui::CalcTextSize("Attack").x,
        ImGui::CalcTextSize("Decay").x, ImGui::CalcTextSize("Sustain").x, ImGui::CalcTextSize("?").x});
    cached = {widestDecimal(1, 8), signedByte, signedByte, dollar + 4 * hexDigit, dollar + 4 * hexDigit,
        dollar + 2 * hexDigit, 100 * fontSize / 16, dollar + 4 * hexDigit + ImGui::CalcTextSize(" ").x,
        dollar + 2 * hexDigit, unsignedByte, signedByte, mode, widestDecimal(0, 1) * 3 + ImGui::CalcTextSize(" / ").x * 2};
    for (size_t column = 0; column < cached.size(); ++column)
        cached[column] = std::ceil(std::max(cached[column], ImGui::CalcTextSize(headers[column]).x) + fontSize * 0.75f);
    return cached;
}
void drawVoiceTable(std::span<const uint8_t, 128> voices) {
    const auto widths = voiceColumnWidths();
    const auto flags = ImGuiTableFlags_Borders | ImGuiTableFlags_ScrollX | ImGuiTableFlags_RowBg |
        ImGuiTableFlags_SizingFixedFit | ImGuiTableFlags_NoSavedSettings;
    if (!ImGui::BeginTable("Voices", 13, flags)) return;
    for (unsigned column = 0; column < widths.size(); ++column)
        ImGui::TableSetupColumn(headers[column], ImGuiTableColumnFlags_WidthFixed | ImGuiTableColumnFlags_NoResize, widths[column]);
    ImGui::TableHeadersRow();
    for (unsigned voice = 0; voice < 8; ++voice) {
        const auto* v = voices.data() + voice * 16;
        ImGui::TableNextRow(); ImGui::TableNextColumn(); ImGui::Text("%u", voice + 1);
        ImGui::TableNextColumn(); ImGui::Text("%d", static_cast<int8_t>(v[0]));
        ImGui::TableNextColumn(); ImGui::Text("%d", static_cast<int8_t>(v[1]));
        ImGui::TableNextColumn(); ImGui::Text("$%04X", word(v + 2));
        ImGui::TableNextColumn(); ImGui::Text("$%04X", word(v + 6));
        ImGui::TableNextColumn(); ImGui::Text("$%02X", v[8]);
        ImGui::TableNextColumn(); ImGui::ProgressBar(std::clamp(word(v + 4) / 2047.0f, 0.0f, 1.0f), ImVec2(-1, 0));
        ImGui::TableNextColumn(); ImGui::Text("$%02X %02X", v[9], v[10]);
        ImGui::TableNextColumn(); ImGui::Text("$%02X", v[11]);
        ImGui::TableNextColumn(); ImGui::Text("%u", v[12]);
        ImGui::TableNextColumn(); ImGui::Text("%d", static_cast<int8_t>(v[13]));
        ImGui::TableNextColumn(); ImGui::TextUnformatted(v[14] < 4 ? std::array{"Release", "Attack", "Decay", "Sustain"}[v[14]] : "?");
        ImGui::TableNextColumn(); ImGui::Text("%u / %u / %u", v[15] & 1, (v[15] >> 1) & 1, (v[15] >> 2) & 1);
    }
    ImGui::EndTable();
}
bool playbackButton(const char* id, PlaybackSymbol symbol, const char* tooltip) {
    const float side = ImGui::GetFrameHeight();
    const auto origin = ImGui::GetCursorScreenPos();
    const bool pressed = ImGui::Button(id, ImVec2(side, side));
    auto* draw = ImGui::GetWindowDrawList(); const auto color = ImGui::GetColorU32(ImGuiCol_Text);
    const auto at = [&](float x, float y) { return ImVec2(origin.x + x * side, origin.y + y * side); };
    if (symbol == PlaybackSymbol::Play) draw->AddTriangleFilled(at(0.37f, 0.25f), at(0.75f, 0.5f), at(0.37f, 0.75f), color);
    else if (symbol == PlaybackSymbol::Pause) {
        draw->AddRectFilled(at(0.31f, 0.26f), at(0.44f, 0.74f), color);
        draw->AddRectFilled(at(0.56f, 0.26f), at(0.69f, 0.74f), color);
    } else {
        const auto center = at(0.5f, 0.5f);
        draw->PathArcTo(center, side * 0.23f, -1.57f, 3.8f);
        draw->PathStroke(color, std::max(1.0f, ImGui::GetFontSize() * 0.1f), ImDrawFlags_None);
        const ImVec2 tip(center.x + std::cos(3.8f) * side * 0.23f, center.y + std::sin(3.8f) * side * 0.23f);
        const ImVec2 tangent(-std::sin(3.8f), std::cos(3.8f));
        draw->AddTriangleFilled(tip, ImVec2(tip.x - side * (0.19f * tangent.x + 0.1f * tangent.y), tip.y - side * (0.19f * tangent.y - 0.1f * tangent.x)),
            ImVec2(tip.x - side * (0.19f * tangent.x - 0.1f * tangent.y), tip.y - side * (0.19f * tangent.y + 0.1f * tangent.x)), color);
    }
    if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", tooltip);
    return pressed;
}
TransportActions drawTransport(const std::string& title, const std::string& game,
    const std::string& status, unsigned seconds, bool playing, bool loaded, float& volume) {
    const float ratio = ImGui::GetFontSize() / 16;
    FlowToolbar row;
    char elapsed[32]; std::snprintf(elapsed, sizeof(elapsed), "%02u:%02u", seconds / 60, seconds % 60);
    const float timeWidth = std::max(ImGui::CalcTextSize("0000:00").x, ImGui::CalcTextSize(elapsed).x);
    TransportActions actions;
    row.next(ImGui::GetFrameHeight());
    actions.playPause = playbackButton("##PlayPause", playing ? PlaybackSymbol::Pause : PlaybackSymbol::Play, playing ? "Pause (Space)" : "Play (Space)");
    row.next(ImGui::GetFrameHeight());
    ImGui::BeginDisabled(!loaded);
    actions.restart = playbackButton("##Restart", PlaybackSymbol::Restart, "Restart");
    ImGui::EndDisabled();
    const float iconWidth = ImGui::GetFrameHeight() * 0.8f;
    const float sliderWidth = std::min(180 * ratio, std::max(1.0f, ImGui::GetWindowWidth() - ImGui::GetStyle().WindowPadding.x * 2 - iconWidth - ImGui::GetStyle().ItemSpacing.x));
    row.next(iconWidth + ImGui::GetStyle().ItemSpacing.x + sliderWidth);
    ImGui::BeginGroup(); speakerSymbol(volume); ImGui::SameLine(); ImGui::SetNextItemWidth(sliderWidth);
    actions.volumeChanged = ImGui::SliderFloat("##Volume", &volume, 0, 1, "%.2f");
    if (ImGui::IsItemHovered()) ImGui::SetTooltip("Volume: %.0f%%", volume * 100);
    ImGui::EndGroup();
    row.next(timeWidth); textSlot(elapsed, timeWidth, ImGui::GetColorU32(ImGuiCol_Text), true);
    row.next(140 * ratio);
    const auto nowPlaying = title + (game.empty() ? "" : "   " + game);
    // Transient loading/error text shares the existing metadata slot. Adding a
    // conditional row here shifts every tab and canvas for a frame or two.
    textSlot(status.empty() ? nowPlaying : status + "   " + nowPlaying,
        ImGui::GetContentRegionAvail().x, ImGui::GetColorU32(ImGuiCol_Text), true);
    ImGui::Separator();
    return actions;
}
}
