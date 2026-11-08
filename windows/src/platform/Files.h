#pragma once
#include <Windows.h>
#include <filesystem>
#include <string>
#include <vector>
namespace visual_spc {
std::string utf8(const std::wstring&);
std::wstring wide(const std::string&);
std::vector<std::filesystem::path> chooseFiles(HWND owner, bool folder = false);
std::filesystem::path chooseSave(HWND owner, const wchar_t* name);
std::filesystem::path dataDirectory();
std::string readText(const std::filesystem::path&, std::size_t maximum = 1024 * 1024);
void saveAtomic(const std::filesystem::path&, const std::string&);
}
