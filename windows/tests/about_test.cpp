#include "ui/About.h"
#include "imgui.h"
#include "test_check.h"
#include <fstream>
#include <iterator>
#include <string>
namespace {
std::string read(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
}
int main(int argc, char** argv) {
    using namespace visual_spc;
    const auto sections = aboutSections();
    const char* paths[] = {"windows/resources/README.txt", "windows/resources/THIRD-PARTY-NOTICES.txt", "LICENSE",
        "LICENSES/LGPL-2.1.txt", "windows/vendor/imgui/LICENSE.txt", "windows/vendor/json/LICENSE.MIT", "windows/resources/BUILDING.txt"};
    for (size_t i = 0; i < sections.size(); ++i) {
        const auto expected = read(std::string(SPC_PROJECT_ROOT) + "/" + paths[i]);
        CHECK(!expected.empty() && sections[i].text == expected);
    }
    const auto source = embeddedSource();
    CHECK(source == read(SPC_SOURCE_BUNDLE));
    CHECK(source.size() > 100000 && source.substr(0, 4) == std::string_view("PK\3\4", 4));
    if (argc == 2) { std::ofstream output(argv[1], std::ios::binary); output.write(source.data(), source.size()); CHECK(output.good()); }
    ImGui::CreateContext(); auto& io = ImGui::GetIO(); io.IniFilename = nullptr; io.DeltaTime = 1.0f / 60;
    io.DisplaySize = ImVec2(900, 650);
    CHECK(io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\segoeui.ttf", 16));
    unsigned char* pixels; int width, height; io.Fonts->GetTexDataAsRGBA32(&pixels, &width, &height);
    for (float dpi : {1.0f, 1.5f, 2.0f, 3.0f}) for (bool expanded : {false, true}) {
        ImGui::GetStyle() = ImGuiStyle(); ImGui::GetStyle().ScaleAllSizes(dpi); ImGui::GetStyle().FontScaleDpi = dpi;
        io.DisplaySize = ImVec2(900 * dpi, 650 * dpi);
        for (int frame = 0; frame < 3; ++frame) {
            ImGui::NewFrame(); ImGui::SetNextWindowPos(ImVec2(0, 0)); ImGui::SetNextWindowSize(io.DisplaySize);
            ImGui::Begin("About check", nullptr, ImGuiWindowFlags_NoDecoration);
            for (const auto& section : sections) ImGui::GetStateStorage()->SetInt(ImGui::GetID(section.title), expanded);
            CHECK(!drawAbout());
            ImGui::End(); ImGui::Render();
        }
    }
    ImGui::DestroyContext();
}
