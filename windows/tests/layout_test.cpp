#include "ui/WorkspaceLayout.h"
#include "ui/PlayerWidgets.h"
#include "imgui_internal.h"
#include "test_check.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <string_view>
#undef CHECK
#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "CHECK failed: %s (%s:%d)\n", #condition, __FILE__, __LINE__); std::exit(1); } } while (0)
using namespace visual_spc;
namespace {
struct Result { ImVec2 plotMin{}, plotMax{}; WorkspaceGeometry regions{}; bool changed = false; unsigned toolbarRows = 0; };
Result render(SidebarState& state, bool waterfall = false, int mode = 0, bool settled = true) {
    Result result;
    ImGui::NewFrame();
    ImGui::SetNextWindowPos(ImVec2(0, 0)); ImGui::SetNextWindowSize(ImGui::GetIO().DisplaySize);
    ImGui::Begin("Layout", nullptr, ImGuiWindowFlags_NoDecoration | fixedRegionFlags);
    float volume = 0.8f;
    drawTransport("A long track title that can be clipped safely", "Game", "", 23, true, true, volume);
    const auto p = ImGui::GetCursorScreenPos(); const auto available = ImGui::GetContentRegionAvail();
    result.regions = workspaceGeometry(p, available, 12 * ImGui::GetStyle().FontScaleDpi + ImGui::GetTextLineHeight() * 2 + ImGui::GetStyle().ItemSpacing.y,
        ImGui::GetStyle().FontScaleDpi, state);
    result.changed = drawWorkspace(state, [&] {
        for (const auto* label : {"ARAM", "Voices", "DSP", "Track", "Settings"}) {
            if (label != std::string_view("ARAM")) ImGui::SameLine();
            ImGui::Selectable(label, false, 0, ImVec2(70 * ImGui::GetStyle().FontScaleDpi, 0));
        }
        ImGui::Separator();
        ImGui::BeginChild("Panel content", ImVec2(0, 0), 0, fixedRegionFlags);
        const float right = ImGui::GetCursorScreenPos().x + ImGui::GetContentRegionAvail().x;
        FlowToolbar toolbar;
        float lastY = -1;
        auto checkItem = [&] {
            CHECK(ImGui::GetItemRectMax().x <= right + 0.5f);
            if (ImGui::GetItemRectMin().y != lastY) { ++result.toolbarRows; lastY = ImGui::GetItemRectMin().y; }
        };
        for (const auto* label : {"Map", "Waterfall"}) {
            toolbar.next(FlowToolbar::toggleWidth(label)); ImGui::RadioButton(label, false); checkItem();
        }
        toolbar.next(120 * ImGui::GetStyle().FontScaleDpi); ImGui::SetNextItemWidth(120 * ImGui::GetStyle().FontScaleDpi);
        int selected = mode; ImGui::Combo("##measurement", &selected, "Activity\0Data\0Entropy\0"); checkItem();
        for (const auto* label : {"Byte", "Bit"}) {
            toolbar.next(FlowToolbar::toggleWidth(label)); ImGui::RadioButton(label, false); checkItem();
        }
        for (const auto* label : {"-", "Fit", "1:1", "+"}) {
            toolbar.next(FlowToolbar::buttonWidth(label)); ImGui::Button(label); checkItem();
        }
        if (waterfall) {
            toolbar.next(65 * ImGui::GetStyle().FontScaleDpi); ImGui::SetNextItemWidth(65 * ImGui::GetStyle().FontScaleDpi);
            int duration = 0; ImGui::Combo("##duration", &duration, "2 s\0" "5 s\0" "10 s\0"); checkItem();
        }
        if (mode != 2) {
            const char* label = mode == 0 ? "Show data underneath" : "XOR";
            toolbar.next(FlowToolbar::toggleWidth(label)); bool value = false; ImGui::Checkbox(label, &value); checkItem();
        }
        const auto space = ImGui::GetContentRegionAvail();
        ImGui::InvisibleButton("##plot", ImVec2(std::max(1.0f, space.x), std::max(1.0f, space.y)));
        result.plotMin = ImGui::GetItemRectMin(); result.plotMax = ImGui::GetItemRectMax();
        if (settled) CHECK(ImGui::GetScrollMaxY() == 0);
        ImGui::EndChild();
        if (settled) CHECK(ImGui::GetScrollMaxY() == 0);
    }, [&] {
        ImGui::TextUnformatted("34917 SPC files");
        ImGui::Button("Open folder"); ImGui::SameLine(); ImGui::Button("Open files");
        ImGui::Button("Save library"); ImGui::Separator();
        ImGui::BeginChild("Tracks", ImVec2(0, 0));
        ImGuiListClipper rows; rows.Begin(10000);
        while (rows.Step()) for (int i = rows.DisplayStart; i < rows.DisplayEnd; ++i) ImGui::Text("Track %d", i);
        ImGui::EndChild(); if (settled) CHECK(ImGui::GetScrollMaxY() == 0);
    }, [] { return FooterText{"Scroll to zoom / drag to pan / hover to inspect", "Read / Write / Execute / overlaps blend",
        "Live / 240 draws/s / target 240 Hz", "Render 0.25 ms / 10 s / 207 MiB history / 0 pending rows"}; });
    if (settled) CHECK(ImGui::GetScrollMaxY() == 0);
    CHECK(result.plotMax.y <= result.regions.footerPosition.y);
    CHECK(result.regions.footerPosition.y + result.regions.footerSize.y <= ImGui::GetIO().DisplaySize.y);
    ImGui::End(); ImGui::Render();
    return result;
}
}
int main() {
    ImGui::CreateContext();
    auto& io = ImGui::GetIO(); io.IniFilename = nullptr; io.DeltaTime = 1.0f / 60;
    CHECK(io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\segoeui.ttf", 16));
    unsigned char* pixels; int width, height;
    io.Fonts->GetTexDataAsRGBA32(&pixels, &width, &height);
    for (const float dpi : {1.0f, 1.25f, 1.5f, 1.75f, 2.0f, 2.5f, 3.0f}) {
        ImGui::GetStyle() = ImGuiStyle();
        auto& style = ImGui::GetStyle(); style.FramePadding = ImVec2(9, 6); style.ItemSpacing = ImVec2(9, 8);
        style.ScaleAllSizes(dpi); style.FontScaleDpi = dpi;
        // Include a client smaller than the minimum outer window (title/frame).
        for (const auto size : {ImVec2(960, 560), ImVec2(1000, 640), ImVec2(1400, 850), ImVec2(1920, 1080)}) {
            io.DisplaySize = ImVec2(size.x * dpi, size.y * dpi);
            for (bool pinned : {false, true}) for (bool open : {false, true}) for (bool waterfall : {false, true}) {
                SidebarState state{open, pinned};
                for (int frame = 0; frame < 3; ++frame) render(state, waterfall, 0, frame == 2);
            }
        }
    }
    ImGui::GetStyle() = ImGuiStyle();
    ImGui::GetStyle().FramePadding = ImVec2(9, 6); ImGui::GetStyle().ItemSpacing = ImVec2(9, 8);
    io.DisplaySize = ImVec2(1400, 850);
    SidebarState state;
    Result open;
    for (int i = 0; i < 3; ++i) open = render(state, false, 0, i == 2);
    CHECK(open.toolbarRows == 1); // Wide controls use a single row.
    auto click = [&](ImVec2 p) {
        io.AddMousePosEvent(p.x, p.y); render(state);
        io.AddMouseButtonEvent(0, true); render(state);
        io.AddMouseButtonEvent(0, false); return render(state);
    };
    auto closed = click(ImVec2(open.regions.tabPosition.x + 10, open.regions.tabPosition.y + 20));
    CHECK(closed.changed && !state.open);
    closed = render(state);
    CHECK(closed.regions.playerPosition.x == open.regions.playerPosition.x);
    CHECK(closed.regions.playerSize.x == open.regions.playerSize.x); // Floating collapse never refits.
    click(ImVec2(closed.regions.tabPosition.x + 10, closed.regions.tabPosition.y + 20));
    CHECK(state.open);
    open = render(state);
    const float frameHeight = ImGui::GetFrameHeight();
    const auto pin = ImVec2(open.regions.libraryPosition.x + open.regions.librarySize.x - ImGui::GetStyle().WindowPadding.x - frameHeight / 2,
        open.regions.libraryPosition.y + ImGui::GetStyle().WindowPadding.y + frameHeight / 2);
    CHECK(click(pin).changed && state.pinned);
    const auto pinned = render(state);
    CHECK(pinned.regions.playerPosition.x > open.regions.playerPosition.x);
    CHECK(pinned.regions.playerSize.x < open.regions.playerSize.x);
    CHECK(click(pin).changed && !state.pinned);
    CHECK(render(state).regions.playerSize.x == open.regions.playerSize.x);
    io.DisplaySize = ImVec2(1000, 640); state = {true, true};
    for (int i = 0; i < 3; ++i) closed = render(state, true, 0, i == 2);
    CHECK(closed.toolbarRows > 1); // Narrow controls wrap without horizontal overflow.
    const auto plotBottom = closed.plotMax.y;
    for (int i = 0; i < 3; ++i) closed = render(state, false, 2, i == 2);
    CHECK(closed.plotMax.y == plotBottom); // All modes end above the same fixed footer.
    ImGui::DestroyContext();
}
