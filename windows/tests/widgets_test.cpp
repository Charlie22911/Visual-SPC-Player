#include "ui/PlayerWidgets.h"
#include "ui/WorkspaceLayout.h"
#include "imgui.h"
#include "imgui_internal.h"
#include "test_check.h"
#include <array>
#include <cstdlib>
#undef CHECK
#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "CHECK failed: %s (%s:%d)\n", #condition, __FILE__, __LINE__); std::exit(1); } } while (0)
using Widths = std::array<float, 13>;
Widths voices(bool extremes) {
    ImGui::NewFrame();
    ImGui::SetNextWindowPos(ImVec2(0, 0)); ImGui::SetNextWindowSize(ImGui::GetIO().DisplaySize);
    ImGui::Begin("Widget check", nullptr, ImGuiWindowFlags_NoDecoration);
    const auto id = ImGui::GetID("Voices");
    std::array<uint8_t, 128> data{};
    data.fill(extremes ? 255 : 1);
    for (unsigned row = 0; row < 8; ++row) {
        data[row * 16] = extremes ? 128 : 1;
        data[row * 16 + 1] = extremes ? 128 : 1;
        data[row * 16 + 13] = extremes ? 128 : 1;
        data[row * 16 + 14] = static_cast<uint8_t>(row % 5);
    }
    visual_spc::drawVoiceTable(data);
    auto* table = ImGui::GetCurrentContext()->Tables.GetByKey(id); CHECK(table);
    const auto required = visual_spc::voiceColumnWidths();
    Widths widths{};
    for (unsigned c = 0; c < 13; ++c) {
        widths[c] = table->Columns[c].WidthGiven;
        CHECK(widths[c] >= required[c] - 1);
    }
    ImGui::End(); ImGui::Render(); return widths;
}
int main() {
    ImGui::CreateContext(); auto& io = ImGui::GetIO(); io.IniFilename = nullptr;
    io.DisplaySize = ImVec2(1400, 850); io.DeltaTime = 1.0f / 60;
    CHECK(io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\segoeui.ttf", 16));
    unsigned char* pixels; int w, h; io.Fonts->GetTexDataAsRGBA32(&pixels, &w, &h);
    for (float dpi : {1.0f, 1.25f, 1.5f, 1.75f, 2.0f, 2.5f, 3.0f}) for (float fontScale : {1.0f, 1.25f, 1.5f}) {
        ImGui::GetStyle() = ImGuiStyle();
        auto& style = ImGui::GetStyle(); style.FramePadding = ImVec2(9, 6); style.ItemSpacing = ImVec2(9, 8);
        style.ScaleAllSizes(dpi); style.FontScaleDpi = dpi; style.FontScaleMain = fontScale;
        for (float clientWidth : {600.0f, 960.0f, 1920.0f}) {
            io.DisplaySize = ImVec2(clientWidth * dpi, 850 * dpi);
            Widths low{}, high{};
            for (int frame = 0; frame < 4; ++frame) low = voices(false);
            for (int frame = 0; frame < 4; ++frame) high = voices(true);
            CHECK(low == high);
            // Transport content and long track/status strings never widen the host.
            for (int frame = 0; frame < 4; ++frame) {
                ImGui::NewFrame();
                ImGui::SetNextWindowPos(ImVec2(0, 0)); ImGui::SetNextWindowSize(io.DisplaySize);
                ImGui::Begin("Transport check", nullptr, ImGuiWindowFlags_NoDecoration | visual_spc::fixedRegionFlags);
                float volume = 0.8f;
                visual_spc::drawTransport(std::string(600, 'W'), std::string(300, 'M'), std::string(600, 'W'), 59999, frame % 2 != 0, true, volume);
                const auto* host = ImGui::GetCurrentWindow();
                CHECK(host->DC.CursorMaxPos.x <= host->Pos.x + host->Size.x - host->WindowPadding.x + 1);
                CHECK(host->DC.CursorMaxPos.y <= host->Pos.y + host->Size.y - host->WindowPadding.y);
                if (frame == 3) CHECK(ImGui::GetScrollMaxX() == 0 && ImGui::GetScrollMaxY() == 0);
                ImGui::End(); ImGui::Render();
            }
        }
    }
    // Vector buttons keep the same hit target for Play/Pause/Restart and use
    // standard ImGui activation. Test actual mouse presses, not mock callbacks.
    ImGui::GetStyle() = ImGuiStyle(); io.DisplaySize = ImVec2(600, 400);
    ImVec2 buttonCenter{}; float side = 0;
    auto symbolFrame = [&](visual_spc::PlaybackSymbol symbol) {
        ImGui::NewFrame(); ImGui::SetNextWindowPos(ImVec2(0, 0)); ImGui::SetNextWindowSize(io.DisplaySize);
        ImGui::Begin("Symbols", nullptr, ImGuiWindowFlags_NoDecoration);
        const bool pressed = visual_spc::playbackButton("##Playback", symbol, "Playback");
        const auto min = ImGui::GetItemRectMin(), max = ImGui::GetItemRectMax();
        buttonCenter = ImVec2((min.x + max.x) / 2, (min.y + max.y) / 2);
        if (side) CHECK(side == max.x - min.x && side == max.y - min.y);
        side = max.x - min.x;
        ImGui::End(); ImGui::Render(); return pressed;
    };
    for (auto symbol : {visual_spc::PlaybackSymbol::Play, visual_spc::PlaybackSymbol::Pause, visual_spc::PlaybackSymbol::Restart}) {
        symbolFrame(symbol); symbolFrame(symbol);
        io.AddMousePosEvent(buttonCenter.x, buttonCenter.y); symbolFrame(symbol);
        io.AddMouseButtonEvent(0, true); CHECK(!symbolFrame(symbol));
        io.AddMouseButtonEvent(0, false); CHECK(symbolFrame(symbol));
    }
    ImGui::DestroyContext();
}
