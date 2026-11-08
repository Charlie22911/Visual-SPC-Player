#include "Files.h"
#include <shobjidl.h>
#include <shlobj.h>
#include <wrl/client.h>
#include <fstream>
#include <stdexcept>
namespace visual_spc {
using Microsoft::WRL::ComPtr;
std::string utf8(const std::wstring& text) {
    if (text.empty()) return {};
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (!count) throw std::runtime_error("Invalid Unicode path");
    std::string output(count, 0);
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), output.data(), count, nullptr, nullptr);
    return output;
}
std::wstring wide(const std::string& text) {
    if (text.empty()) return {};
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (!count) throw std::runtime_error("Invalid UTF-8 text");
    std::wstring output(count, 0);
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), output.data(), count);
    return output;
}
namespace {
std::filesystem::path itemPath(IShellItem* item) {
    PWSTR raw = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &raw))) return {};
    std::filesystem::path path(raw); CoTaskMemFree(raw); return path;
}
}
std::vector<std::filesystem::path> chooseFiles(HWND owner, bool folder) {
    ComPtr<IFileOpenDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))))
        throw std::runtime_error("File dialog is unavailable");
    DWORD flags = 0; dialog->GetOptions(&flags);
    dialog->SetOptions(flags | FOS_FORCEFILESYSTEM | (folder ? FOS_PICKFOLDERS : FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST));
    if (!folder) {
        const COMDLG_FILTERSPEC types[] = {{L"SPC files", L"*.spc"}, {L"JSON settings", L"*.json"}, {L"All files", L"*.*"}};
        dialog->SetFileTypes(3, types);
    }
    if (dialog->Show(owner) == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return {};
    ComPtr<IShellItemArray> items;
    if (FAILED(dialog->GetResults(&items))) return {};
    DWORD count = 0; items->GetCount(&count);
    std::vector<std::filesystem::path> paths;
    for (DWORD i = 0; i < count; ++i) {
        ComPtr<IShellItem> item; if (SUCCEEDED(items->GetItemAt(i, &item))) paths.push_back(itemPath(item.Get()));
    }
    return paths;
}
std::filesystem::path chooseSave(HWND owner, const wchar_t* name) {
    ComPtr<IFileSaveDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))))
        throw std::runtime_error("Save dialog is unavailable");
    dialog->SetFileName(name); dialog->SetDefaultExtension(L"json");
    const COMDLG_FILTERSPEC types[] = {{L"JSON", L"*.json"}}; dialog->SetFileTypes(1, types);
    if (FAILED(dialog->Show(owner))) return {};
    ComPtr<IShellItem> item; if (FAILED(dialog->GetResult(&item))) return {};
    return itemPath(item.Get());
}
std::filesystem::path dataDirectory() {
    PWSTR raw = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &raw)))
        throw std::runtime_error("Local application data is unavailable");
    auto path = std::filesystem::path(raw) / L"VisualSPCPlayer"; CoTaskMemFree(raw); return path;
}
std::string readText(const std::filesystem::path& path, std::size_t maximum) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) throw std::runtime_error("Could not open " + utf8(path.filename().wstring()));
    const auto size = input.tellg();
    if (size < 0 || static_cast<uint64_t>(size) > maximum) throw std::runtime_error("File exceeds the supported size");
    std::string text(static_cast<size_t>(size), 0); input.seekg(0);
    if (!input.read(text.data(), static_cast<std::streamsize>(text.size()))) throw std::runtime_error("File read failed");
    return text;
}
void saveAtomic(const std::filesystem::path& path, const std::string& text) {
    if (!path.parent_path().empty()) std::filesystem::create_directories(path.parent_path());
    auto temporary = path; temporary += L".tmp";
    {
        std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
        output.write(text.data(), static_cast<std::streamsize>(text.size())); output.flush();
        if (!output) throw std::runtime_error("Could not write " + utf8(path.filename().wstring()));
    }
    if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("Could not replace " + utf8(path.filename().wstring()));
}
}
