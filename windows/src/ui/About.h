#pragma once
#include <array>
#include <string_view>
namespace visual_spc {
struct AboutSection { const char* title; std::string_view text; };
std::array<AboutSection, 7> aboutSections();
std::string_view embeddedSource();
// Returns true when the user requests a source ZIP export.
bool drawAbout();
}
